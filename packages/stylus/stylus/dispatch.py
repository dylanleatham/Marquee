"""Publishing off the poll loop (stylus-spec §8,
[ADR 0082](../../../docs/adrs/0082-publishing-moves-off-the-poll-loop.md)).

``Publisher.publish`` used to be called synchronously from ``StylusApp.tick()`` — which *is* the poll
loop — so the reader stopped reading for as long as a publish took. With the shipped timeouts and
§8's retry window that is ~43s of blindness for one event against dead downstreams, and ~87s on a
swap. Lifting the sleeve goes unnoticed, placing a different one goes unnoticed, and the stand feels
like bad hardware exactly when you're trying to tune the mount
([#173](https://github.com/dylanleatham/Marquee/issues/173)).

The fix is a queue and one worker: the loop hands the event over and goes back to reading.

**One worker, FIFO, deliberately.** The thing that must not be concurrent is *events* — a `stop`
that overtakes its `start` leaves the lights on with nothing left to correct it. Concurrency between
downstreams would be safe, but it isn't what costs the loop its time.

**The queue is bounded and drops the oldest.** Unbounded, a long outage grows it until a Pi Zero
runs out of memory. When it does overflow, the stale events are the ones worth losing: §8 already
requires downstreams to tolerate a missed `stop` by timing out their own state, so the newest events
— the ones that still describe what's on the stand — are what to keep.

**Nothing here feeds the systemd watchdog.** That is a correctness requirement, not an oversight:
the watchdog exists to notice a wedged *poll loop*, so if this thread pinged it, a healthy publisher
would mask a dead reader and quietly undo [ADR 0077](../../../docs/adrs/0077-the-poll-loop-proves-it-is-alive.md).
`Publisher` no longer accepts a heartbeat at all, so it can't happen by accident.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from collections.abc import Callable
from typing import Any

log = logging.getLogger("stylus.dispatch")

#: What the worker calls. Shaped like ``Publisher.publish``: takes an event, returns per-downstream
#: delivery results, and is documented never to raise (we defend anyway).
PublishFn = Callable[[dict[str, Any]], dict[str, bool]]

#: Deep enough that only a genuinely long outage reaches it (at one event per sleeve movement, this
#: is far more than anyone will produce by hand), shallow enough to stay small on a Pi Zero.
DEFAULT_MAX_DEPTH = 64

#: How long :meth:`Dispatcher.stop` waits for the worker to finish the backlog. Long enough for one
#: in-flight publish to finish its retry window, short enough not to hang a `systemctl restart`.
DEFAULT_STOP_TIMEOUT_S = 10.0


class Dispatcher:
    """A bounded FIFO of scan events, drained by one worker thread.

    :meth:`submit` never blocks and never raises — it is called from the poll loop, and the whole
    point of this class is that the loop keeps its time.
    """

    def __init__(
        self,
        publish: PublishFn,
        *,
        max_depth: int = DEFAULT_MAX_DEPTH,
        on_idle: Callable[[], None] | None = None,
    ) -> None:
        if max_depth < 1:
            # 0 would drop every event and publish nothing, in silence — a stand that reads tags
            # perfectly and tells no one.
            raise ValueError(f"max_depth must be >= 1, got {max_depth}")
        self._publish = publish
        self._max_depth = max_depth
        self._on_idle = on_idle
        self._queue: deque[dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopping = False
        self._dropped = 0
        self._health: dict[str, bool] = {}
        self._thread: threading.Thread | None = None
        self._started = False

    # --- the poll loop's side -------------------------------------------------------------------
    def submit(self, event: dict[str, Any]) -> None:
        """Queue ``event`` and return. Drops the stalest event if the queue is already full."""
        with self._lock:
            if len(self._queue) >= self._max_depth:
                dropped = self._queue.popleft()
                self._dropped += 1
                log.warning(
                    "publish backlog full (%d) — dropped the oldest %s event; "
                    "a downstream has been unreachable for a while",
                    self._max_depth,
                    dropped.get("event"),
                )
            self._queue.append(event)
        self._wake.set()

    def health(self) -> dict[str, bool]:
        """Per-downstream results of the **last completed** publish (``{}`` before the first).

        Not of the event just submitted — that one hasn't been sent yet. Empty means "no news",
        which is what keeps an untried publisher from lighting the error LED.
        """
        with self._lock:
            return dict(self._health)

    def stats(self) -> dict[str, int]:
        """Backlog depth and lifetime drop count, for ``GET /status``."""
        with self._lock:
            return {"depth": len(self._queue), "dropped": self._dropped}

    # --- the worker's side ----------------------------------------------------------------------
    def run_pending(self) -> int:
        """Publish everything queued *right now* and return how many. Synchronous.

        The worker loop is this plus a wait, which keeps the interesting behaviour — ordering, the
        drop rule, health, surviving a raising publish — testable without a thread in sight.
        """
        count = 0
        while True:
            with self._lock:
                if not self._queue:
                    break
                event = self._queue.popleft()
            count += 1
            try:
                result = self._publish(event)
            except Exception:  # noqa: BLE001 — one bad publish must not end publishing forever
                log.exception("publishing %s failed — continuing", event.get("event"))
                continue
            with self._lock:
                self._health = dict(result)
        return count

    def start(self) -> None:
        """Spawn the worker. Daemon, because it waits on the network and must not hold shutdown."""
        if self._thread is not None:
            return
        self._started = True
        self._thread = threading.Thread(target=self._run, name="stylus-publish", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            self.run_pending()
            if self._on_idle is not None:
                self._on_idle()
            if self._stopping:
                self.run_pending()  # anything submitted during that last pass
                return

    def stop(self, timeout_s: float = DEFAULT_STOP_TIMEOUT_S) -> None:
        """Ask the worker to finish the backlog and go. Safe to call twice, or without :meth:`start`.

        The backlog is drained rather than discarded: the event most likely to be sitting in it at
        shutdown is a `stop`, and dropping that leaves the lights on with Stylus gone.
        """
        self._stopping = True
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is None:
            # Only flush inline if a worker never existed. `self._thread` is also None on a *second*
            # stop() — and if the first one timed out, its worker is still draining this queue, so
            # publishing from the caller's thread here would put two threads on it and break the
            # ordering the whole design rests on.
            if not self._started:
                self.run_pending()  # publish inline so nothing is silently lost
            return
        thread.join(timeout_s)
        if thread.is_alive():
            log.warning("publish worker still busy after %.0fs — leaving it behind", timeout_s)


class QueuedPublisher:
    """:class:`~stylus.publisher.Publisher`-shaped, but returns immediately.

    Same two-method surface the app already uses, so the poll loop needs no knowledge of threads:
    :meth:`publish` queues and hands back the *last completed* publish's health rather than this
    event's. That substitution is the entire behavioural change of
    [#173](https://github.com/dylanleatham/Marquee/issues/173), which is why it lives in one small
    named class instead of being spread through ``StylusApp``.
    """

    def __init__(self, dispatcher: Dispatcher) -> None:
        self._dispatcher = dispatcher

    def publish(self, event: dict[str, Any]) -> dict[str, bool]:
        self._dispatcher.submit(event)
        return self._dispatcher.health()

    def stats(self) -> dict[str, int]:
        return self._dispatcher.stats()
