"""Publishing off the poll loop (stylus-spec §8, [ADR 0078], issue #173).

The bug these guard: ``Publisher.publish`` was called synchronously from ``StylusApp.tick()`` — the
poll loop — so the reader stopped reading for as long as a publish took. With the shipped timeouts
that is ~43s for one event against dead downstreams, ~87s on a swap. During that window lifting the
sleeve isn't noticed and neither is placing a different one, which reads as flaky hardware and sends
you hunting in the antenna and the mount. #173 filed it; step-11 bring-up is where it bit.

The design question is ordering. A `stop` that overtakes its `start` leaves the lights on forever,
so the queue is FIFO and drained by exactly **one** worker — concurrency between *events* is what
would break, not concurrency between downstreams.

The policy (bounds, drop rule, ordering, health) is tested synchronously via ``run_pending``; the
thread gets its own small set. Nothing here sleeps to synchronise — a test that passes by waiting is
a test that fails on a loaded CI box.
"""

import threading

import pytest

from stylus.dispatch import Dispatcher, QueuedPublisher

EVENT_A = {"event": "start", "uri": "curator:album:aaaa1111", "at": "t1"}
EVENT_B = {"event": "stop", "at": "t2"}
PATIENCE = 5.0


class RecordingPublish:
    """Stands in for ``Publisher.publish``: records events, returns a canned health map."""

    def __init__(self, health=None, blocker: threading.Event | None = None) -> None:
        self.events: list[dict] = []
        self._health = health or {"conductor": True}
        self._blocker = blocker

    def __call__(self, event: dict) -> dict:
        if self._blocker is not None:
            self._blocker.wait(PATIENCE)
        self.events.append(event)
        return dict(self._health)


# --- the policy, drained synchronously ----------------------------------------------------------


def test_submit_does_not_publish_by_itself():
    """The whole point: the caller (the poll loop) hands the event over and moves on."""
    pub = RecordingPublish()
    Dispatcher(pub).submit(EVENT_A)
    assert pub.events == []


def test_draining_publishes_what_was_queued():
    pub = RecordingPublish()
    d = Dispatcher(pub)
    d.submit(EVENT_A)
    assert d.run_pending() == 1
    assert pub.events == [EVENT_A]


def test_events_keep_their_order():
    # A stop that overtakes its start leaves the room lit and the video playing, with nothing
    # left to correct it. One worker, FIFO — that's why there is no thread pool here.
    pub = RecordingPublish()
    d = Dispatcher(pub)
    d.submit(EVENT_A)
    d.submit(EVENT_B)
    d.run_pending()
    assert pub.events == [EVENT_A, EVENT_B]


def test_draining_an_empty_queue_is_a_no_op():
    assert Dispatcher(RecordingPublish()).run_pending() == 0


def test_the_queue_is_bounded_and_drops_the_stalest_first():
    # Unbounded, a long outage grows the queue until the Pi Zero runs out of memory. Dropping the
    # *oldest* keeps the events that still describe reality — and §8 already says downstreams must
    # tolerate a missed stop (they time out their own state).
    pub = RecordingPublish()
    d = Dispatcher(pub, max_depth=2)
    for i in range(5):
        d.submit({"event": "start", "n": i})
    d.run_pending()
    assert [e["n"] for e in pub.events] == [3, 4]
    assert d.stats()["dropped"] == 3


def test_submitting_past_the_bound_still_never_blocks():
    d = Dispatcher(RecordingPublish(), max_depth=1)
    for i in range(100):
        d.submit({"event": "start", "n": i})  # must return immediately, never wait for room
    assert d.stats()["depth"] == 1


def test_stats_report_the_backlog():
    d = Dispatcher(RecordingPublish())
    d.submit(EVENT_A)
    d.submit(EVENT_B)
    assert d.stats() == {"depth": 2, "dropped": 0}
    d.run_pending()
    assert d.stats() == {"depth": 0, "dropped": 0}


def test_a_publish_that_raises_does_not_stop_the_worker():
    # Publisher.publish is documented never to raise, but a bug there must not silently end
    # publishing for the rest of the process's life — that would be a dead stand with a live log.
    seen = []

    def publish(event):
        seen.append(event)
        raise RuntimeError("boom")

    d = Dispatcher(publish)
    d.submit(EVENT_A)
    d.submit(EVENT_B)
    assert d.run_pending() == 2
    assert seen == [EVENT_A, EVENT_B]


def test_health_from_the_last_completed_publish_is_reported():
    d = Dispatcher(RecordingPublish(health={"conductor": False, "backdrop": True}))
    d.submit(EVENT_A)
    d.run_pending()
    assert d.health() == {"conductor": False, "backdrop": True}


def test_health_starts_empty_because_nothing_has_been_published_yet():
    # `StylusApp._last_publish_failed` treats an empty map as "no news", not as failure — an
    # untried publisher must not light the error LED.
    assert Dispatcher(RecordingPublish()).health() == {}


def test_health_survives_a_publish_that_raises():
    d = Dispatcher(RecordingPublish(health={"conductor": True}))
    d.submit(EVENT_A)
    d.run_pending()

    def boom(event):
        raise RuntimeError("boom")

    d._publish = boom  # noqa: SLF001 — swapping the transport mid-flight is the point of the test
    d.submit(EVENT_B)
    d.run_pending()
    assert d.health() == {"conductor": True}, "a crash must not read as every downstream failing"


# --- the worker thread ---------------------------------------------------------------------------


def test_the_worker_publishes_without_the_caller_waiting():
    pub = RecordingPublish()
    done = threading.Event()
    d = Dispatcher(pub, on_idle=done.set)
    d.start()
    try:
        d.submit(EVENT_A)
        assert done.wait(PATIENCE), "worker never drained the queue"
        assert pub.events == [EVENT_A]
    finally:
        d.stop()


def test_submit_returns_while_a_publish_is_still_in_flight():
    """#173 itself: a slow downstream must not hold up the next poll."""
    blocker = threading.Event()
    pub = RecordingPublish(blocker=blocker)
    d = Dispatcher(pub)
    d.start()
    try:
        d.submit(EVENT_A)
        d.submit(EVENT_B)  # returns immediately even though EVENT_A is still blocked in publish
        assert pub.events == []  # still stuck in the first publish
    finally:
        blocker.set()
        d.stop()


def test_stop_drains_what_is_already_queued():
    # A stop event submitted just before shutdown is the one you most want delivered — otherwise
    # the lights stay on after Stylus goes away.
    pub = RecordingPublish()
    d = Dispatcher(pub)
    d.start()
    d.submit(EVENT_A)
    d.stop()
    assert pub.events == [EVENT_A]


def test_stop_is_safe_without_start():
    Dispatcher(RecordingPublish()).stop()  # must not hang or raise


def test_stop_is_idempotent():
    d = Dispatcher(RecordingPublish())
    d.start()
    d.stop()
    d.stop()


def test_the_worker_is_a_daemon_thread():
    # It waits on the network. A non-daemon worker would hold the interpreter open on shutdown.
    d = Dispatcher(RecordingPublish())
    d.start()
    try:
        assert d._thread.daemon is True  # noqa: SLF001
    finally:
        d.stop()


# --- the Publisher-shaped wrapper the app sees --------------------------------------------------


def test_queued_publisher_returns_immediately_and_publishes_later():
    pub = RecordingPublish(health={"conductor": True})
    d = Dispatcher(pub)
    q = QueuedPublisher(d)
    assert q.publish(EVENT_A) == {}, "no completed publish yet, so no news"
    assert pub.events == []
    d.run_pending()
    assert q.publish(EVENT_B) == {"conductor": True}, "now reporting the last completed publish"


def test_queued_publisher_exposes_the_backlog():
    d = Dispatcher(RecordingPublish())
    q = QueuedPublisher(d)
    q.publish(EVENT_A)
    assert q.stats()["depth"] == 1


@pytest.mark.parametrize("depth", [0, -1])
def test_a_nonsense_bound_is_refused(depth):
    # max_depth=0 would drop every event and publish nothing, silently.
    with pytest.raises(ValueError):
        Dispatcher(RecordingPublish(), max_depth=depth)


def test_stop_without_start_still_publishes_what_was_queued():
    # `stop()` on a never-started dispatcher flushes inline rather than discarding — otherwise a
    # wiring mistake (submit, shut down, never started the worker) loses events in silence.
    pub = RecordingPublish()
    d = Dispatcher(pub)
    d.submit(EVENT_A)
    d.stop()
    assert pub.events == [EVENT_A]


def test_a_second_stop_does_not_publish_alongside_an_abandoned_worker():
    """A `stop()` that times out leaves its worker draining the queue. A second `stop()` must not
    then publish from the caller's thread too — two threads on one queue is exactly the ordering
    violation the single-worker design exists to prevent."""
    blocker = threading.Event()
    pub = RecordingPublish(blocker=blocker)
    d = Dispatcher(pub)
    d.start()
    d.submit(EVENT_A)
    d.stop(timeout_s=0.05)  # times out: the worker is still stuck inside publish
    d.submit(EVENT_B)
    d.stop(timeout_s=0.05)  # must not drain EVENT_B here
    assert pub.events == []
    blocker.set()
