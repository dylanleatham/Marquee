"""The Stylus app — wires the reader, state machine, publisher, and LED into one poll loop.

``tick()`` is one poll cycle and is the unit the tests drive; ``run()`` just calls it every
``poll_interval_ms``. All action → HTTP/LED effects live here so the state machine stays pure.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from .config import Config
from .events import now_iso, start_event, stop_event
from .led import Led, Pattern
from .publisher import EventPublisher, QueueReporting
from .reader import DriveReporting, TagReader
from .state_machine import BadTag, DetectionMachine, Start, State, Stop, Swap
from .switch import AlwaysLive, Switch

log = logging.getLogger("stylus.app")


class StylusApp:
    def __init__(
        self,
        config: Config,
        reader: TagReader,
        publisher: EventPublisher,
        led: Led,
        *,
        now: Callable[[], str] = now_iso,
        sleep: Callable[[float], None] = time.sleep,
        heartbeat: Callable[[], None] = lambda: None,
        switch: Switch | None = None,
    ) -> None:
        self._cfg = config
        self._reader = reader
        self._publisher = publisher
        self._led = led
        self._now = now
        self._sleep = sleep
        self._heartbeat = heartbeat
        # No switch wired ⇒ always live, so every existing caller behaves exactly as before.
        self._switch = switch if switch is not None else AlwaysLive()
        self._live = True
        self._machine = DetectionMachine(config.reader)
        self._reader_id = config.reader.id
        self._running = False
        # Observability for GET /status.
        self._last_event: dict[str, Any] | None = None
        self._downstream_health: dict[str, bool] = {}
        # What the *reader* saw, as opposed to what the machine did with it.
        #
        # Everything else here describes the state machine, so it only ever populates once an album
        # has actually started playing. A sleeve sitting on the reader being rejected — an unwritten
        # tag, a garbled NDEF, a URI for some other scheme — left /status looking exactly like an
        # empty stand, which is the one case you need it for (issue #198's bring-up debugging).
        self._observed: dict[str, Any] | None = None
        self._last_bad_tag: dict[str, Any] | None = None
        # Reader odometer, behind `GET /healthz` (#350). Deliberately *not* `_blind_polls` below:
        # that one is scoped to PLAYING and resets on every state change, because it exists to log a
        # dropout mid-record. The 40-hour blind run in #350 happened entirely inside IDLE, where
        # `_blind_polls` is pinned at zero by design — so the question "has this reader read anything
        # at all, ever" needs a counter that no state transition clears.
        self._last_read_at: str | None = None
        self._polls_since_read = 0
        # Consecutive polls the reader saw nothing while the machine was PLAYING (#337). Only for
        # the log line — the removal debounce itself lives in the machine, and duplicating it here
        # is exactly the drift that would make the two disagree.
        self._blind_polls = 0
        # Read at construction rather than waiting for the first tick, so a stand that boots with
        # the switch already off never shows a breathing "ready" LED — not even for one poll. This
        # is the case that matters: a restart is exactly when the room must not wake itself up.
        self._live = self._switch.is_live()
        self._led.set(Pattern.IDLE if self._live else Pattern.OFF)

    # --- one poll cycle ---------------------------------------------------------------------------
    def tick(self):
        # Announce the pass *before* doing anything that can block, so a tick that never returns has
        # already spent as little of the watchdog deadline as possible (§12, #308). It lives here
        # rather than in `run()` because this is the unit the tests drive — `run()` is a bare loop.
        self._heartbeat()
        self._read_switch()
        tag = self._reader.poll()
        # Recorded before the machine runs, and regardless of what it decides: a tag the machine
        # ignores is exactly the one worth reporting. That includes a switched-off stand — the whole
        # point of `observed` is telling an empty stand from one that is choosing not to react.
        self._observed = (
            None if tag is None else {"uid": tag.uid, "uri": tag.uri, "at": self._now()}
        )
        self._note_read(tag)
        # A switched-off stand shows the machine an *empty* stand ([ADR 0093]). Everything then
        # falls out of debounce logic that already exists and is already tested: flipping off while
        # playing runs the ordinary removal debounce, so a normal `stop` fires and the room returns
        # to its pre-scan state rather than freezing on the last record's palette; flipping back on
        # with a sleeve still sitting there runs the ordinary insertion debounce, so a normal
        # `start` fires. No resume path, no suppressed-event bookkeeping, no third machine state.
        # Before `observe`, so the state consulted is the one the reader's sighting applies to.
        self._note_reader_gap(tag)
        action = self._machine.observe(tag if self._live else None)
        if action is not None:
            self._handle(action)
        self._apply_steady_led()
        return action

    def _note_read(self, tag) -> None:
        """Odometer behind ``GET /healthz`` (#350): when the reader last saw *anything*.

        Counts **sightings, not decodes**. An unwritten or garbled tag still proves the analog front
        end is coupling, which is the thing that degraded in [#322]; gating this on a successful NDEF
        parse would call a perfectly healthy reader dead the first time you set a blank sticker down.

        A quiet stand reads nothing and that is not a fault, so nothing here ever fails a health
        check — see :meth:`reader_health` for why the numbers are reported rather than judged.

        [#322]: https://github.com/dylanleatham/Marquee/issues/322
        """
        if tag is None:
            self._polls_since_read += 1
        else:
            self._last_read_at = self._now()
            self._polls_since_read = 0

    def _note_reader_gap(self, tag) -> None:
        """Say when the reader loses a tag it was playing, and how long it stayed lost (#337).

        A gap *shorter* than the removal debounce publishes nothing, so it is invisible in every
        other signal the system has — and it is the one worth seeing, because it is what says the
        coupling has gone marginal shortly before the stand starts cycling stop/start. A gap that
        does reach the debounce gets this line as well as the `stop`, which is what turns "the room
        restarted" into "the reader went blind for 12 polls".

        A switched-off stand is skipped: masking the tag is [ADR 0093] working as designed, not the
        reader faltering, and a scary line on every flip of the switch would train you to ignore it.
        """
        if not self._live or self._machine.state is not State.PLAYING:
            self._blind_polls = 0
            return
        if tag is None:
            self._blind_polls += 1
            if self._blind_polls == 1:
                log.warning("reader lost the tag it was playing (%s)", self._machine.current_uid)
        elif self._blind_polls:
            log.info("reader re-acquired the tag after %d blind poll(s)", self._blind_polls)
            self._blind_polls = 0

    def _read_switch(self) -> None:
        live = self._switch.is_live()
        if live != self._live:
            # At INFO because this is the first thing to check when the stand "stopped working".
            log.info("stand switched %s", "live" if live else "off")
            self._live = live

    def _handle(self, action) -> None:
        if isinstance(action, Start):
            self._publish(start_event(action.uri, action.uid, self._reader_id, at=self._now()))
            self._ack_start()
        elif isinstance(action, Swap):
            # §7 SWAP: stop the old album, then start the new one. No IDLE in between.
            self._publish(stop_event(self._reader_id, at=self._now()))
            self._publish(start_event(action.uri, action.uid, self._reader_id, at=self._now()))
            self._ack_start()
        elif isinstance(action, Stop):
            self._publish(stop_event(self._reader_id, at=self._now()))
        elif isinstance(action, BadTag):
            log.warning(
                "tag %s carried no valid curator:(album|card|demo) URI — ignoring", action.uid
            )
            # Kept after the sleeve is lifted, so "I took it off before I thought to look" still has
            # an answer. `observed` goes null the moment the reader sees nothing; this does not.
            self._last_bad_tag = {
                "uid": action.uid,
                "uri": self._observed["uri"] if self._observed else None,
                "at": self._now(),
            }
            self._led.set(Pattern.ERROR)

    def _ack_start(self) -> None:
        # §7 "two short blinks: I heard you" — fired on *acceptance*, unconditionally.
        #
        # It used to be conditional on the publish having succeeded, which was right while
        # publishing was synchronous: the health map described this very event. Since #173 it
        # describes the last *completed* publish, which may be some earlier event entirely — so
        # gating on it would mean a stand that silently stops acknowledging scans it accepted
        # perfectly, for as long as a downstream is unwell. The network's opinion still arrives, as
        # the ERROR pattern _apply_steady_led settles to at the end of this tick.
        self._led.set(Pattern.START_ACK)

    def _publish(self, event: dict[str, Any]) -> None:
        # Every event, at INFO (#337). The stand used to publish in total silence, so reconstructing
        # a stop/start cycle meant reading *Amp's* HTTP response times on another host and inferring
        # the event kinds from how long each took. The stand's own journal should not be the last
        # place that knows what the stand did.
        uri = event.get("uri")
        log.info("publishing %s%s", event["event"], f" {uri}" if uri else "")
        self._last_event = event
        self._downstream_health = self._publisher.publish(event)

    def _apply_steady_led(self) -> None:
        # OFF outranks ERROR: while the stand is off it publishes nothing, so a stale unhealthy
        # downstream from before the flip isn't something the LED should still be shouting about —
        # and "why is my stand blinking angrily" has a much better answer than "check the network".
        if not self._live:
            self._led.set(Pattern.OFF)
        elif self._last_publish_failed():
            self._led.set(Pattern.ERROR)
        elif self._machine.state is State.PLAYING:
            self._led.set(Pattern.PLAYING)
        else:
            self._led.set(Pattern.IDLE)

    def _last_publish_failed(self) -> bool:
        return bool(self._downstream_health) and not all(self._downstream_health.values())

    # --- loop -------------------------------------------------------------------------------------
    def run(self) -> None:  # pragma: no cover - trivial loop, exercised via tick() in tests
        self._running = True
        interval = self._cfg.reader.poll_interval_ms / 1000
        log.info("Stylus polling at %dms (reader=%s)", self._cfg.reader.poll_interval_ms, self._reader_id)
        while self._running:
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — a poll must never kill the loop (§12 PN532 hangs)
                log.exception("poll tick failed — continuing")
            self._sleep(interval)

    def stop(self) -> None:
        self._running = False

    # --- health (GET /healthz, §8.3) ---------------------------------------------------------------
    def reader_health(self) -> dict[str, Any]:
        """What ``GET /healthz`` can honestly say about the reader (#350).

        It is **not** a chip probe, and that is the whole point. [#322] established that the
        firmware-version read answers normally — ``firmware=(50, 1, 6, 7)``, five times over — while
        the reader is hearing nothing at all, so a probe-based health check reports green through
        exactly the failure you built it for. "Is the chip there" and "can the reader hear a tag" are
        different questions and only the second one keeps the room lit.

        So this reports the only signal that tracks the fault: whether tags are being *seen*. It
        deliberately does not judge them. An empty stand polls forever and reads nothing, so a low
        read count is the normal state of a quiet room and ``ok`` must never alarm on it — what the
        numbers buy you is the distinction between "nobody has placed a record" and "this reader
        stopped hearing them 40 hours ago", which is the one #350 could not make.

        [#322]: https://github.com/dylanleatham/Marquee/issues/322
        """
        return {
            "ok": True,
            "readerId": self._reader_id,
            "lastReadAt": self._last_read_at,
            "pollsSinceRead": self._polls_since_read,
        }

    # --- status (GET /status, §8) -----------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        return {
            "state": self._machine.state.value,
            "readerId": self._reader_id,
            # The stand's on/off switch ([ADR 0093]). `source` is here because an unwired or broken
            # switch degrades to "always live" (see stylus/switch.py) — without it, a switch that
            # does nothing and a switch that is simply on report identically, and the failure you'd
            # be debugging is "I flipped it and the room kept going".
            "switch": {"live": self._live, "source": self._switch.source},
            # The machine's view: what is *playing*. Null until a scan actually fired.
            "lastUid": self._machine.current_uid,
            "lastUri": self._machine.current_uri,
            "lastEvent": self._last_event,
            "downstreamHealth": self._downstream_health,
            # The reader's view: what is *on the stand right now*, decoded or not. Null means the
            # reader sees nothing — which is how you tell an empty stand from a rejected sleeve.
            "observed": self._observed,
            # The last tag the machine refused, remembered across removal.
            "lastBadTag": self._last_bad_tag,
            # The transmit drive, and where the number comes from. Diagnosing #303 meant stopping
            # the service to read the chip, because nothing reported what it had been configured
            # with — and the settings are volatile, so "what the config file says" is not the same
            # question. This field then answered the config anyway (#351), which is the question it
            # was built to stop people asking.
            "rf": self._rf_status(),
            # Backlog of the async publisher (#173). A depth that keeps climbing, or a non-zero
            # `dropped`, is the observable form of "a downstream is unreachable and events are
            # piling up"; without it, "the lights react late" would have no visible cause anywhere.
            # Null only when the publisher has no queue at all — `__main__` always wires one, so in
            # practice that means unit-test wiring that passes a bare publisher.
            "publishQueue": self._publish_queue_stats(),
        }

    def _rf_status(self) -> dict[str, Any]:
        """The transmit drive, plus a ``source`` saying whether a chip was ever given it (#351).

        ``source: "chip"`` means a PN532 was configured with these values at bring-up;
        ``"config"`` means nothing was — a bench run on the simulated reader, where the numbers are
        an intention rather than a fact. Without the discriminator those two report identically,
        which is the same failure ``switch.source`` exists to prevent ([ADR 0093]).

        **This is the drive written at bring-up, not a read-back.** The PN532 has no command to
        report its analog settings, and [#322] found no reset pin is wired, so a chip that reset
        underneath a running process cannot be detected from here — it would keep reporting
        ``"chip"`` with the values it was given before the reset. Closing that needs a
        ``ReadRegister`` probe against the CIU registers, verified on real hardware; it is tracked on
        #351 rather than guessed at here, because a register address guessed wrong prints a
        confidently wrong number, which is worse than the honest limit.

        [#322]: https://github.com/dylanleatham/Marquee/issues/322
        """
        if isinstance(self._reader, DriveReporting):
            gsn_on, cw_gsp = self._reader.applied_tx_drive()
            return {"gsnOn": gsn_on, "cwGsp": cw_gsp, "source": "chip"}
        return {"gsnOn": self._cfg.rf.gsn_on, "cwGsp": self._cfg.rf.cw_gsp, "source": "config"}

    def _publish_queue_stats(self) -> dict[str, int] | None:
        p = self._publisher
        return p.stats() if isinstance(p, QueueReporting) else None
