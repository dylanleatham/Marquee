from stylus.app import StylusApp
from stylus.config import Config, ReaderConfig
from stylus.led import Pattern
from stylus.reader import SimulatedReader

URI_A = "curator:album:aaaa1111"
URI_B = "curator:album:bbbb2222"


class FakePublisher:
    def __init__(self, health=None):
        self.events = []
        self._health = health or {"conductor": True, "backdrop": True}

    def publish(self, event):
        self.events.append(event)
        return dict(self._health)


class RecordingLed:
    def __init__(self):
        self.patterns = []

    def set(self, pattern):
        self.patterns.append(pattern)


def build(health=None):
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=2, removal_debounce_polls=2))
    reader = SimulatedReader()
    pub = FakePublisher(health)
    led = RecordingLed()
    app = StylusApp(cfg, reader, pub, led, now=lambda: "2026-07-21T00:00:00Z")
    return app, reader, pub, led


def test_insertion_publishes_start_and_lights_playing():
    app, reader, pub, led = build()
    reader.set_tag("A", URI_A)
    assert app.tick() is None  # 1st positive read
    app.tick()  # 2nd → Start
    assert pub.events == [
        {
            "event": "start",
            "uri": URI_A,
            "tagUid": "A",
            "readerId": "primary",
            "at": "2026-07-21T00:00:00Z",
        }
    ]
    assert led.patterns[-1] is Pattern.PLAYING
    assert app.status()["state"] == "playing"
    assert app.status()["lastUri"] == URI_A


def test_removal_publishes_stop_and_lights_idle():
    app, reader, pub, led = build()
    reader.set_tag("A", URI_A)
    app.tick()
    app.tick()  # PLAYING
    reader.clear()
    app.tick()
    app.tick()  # removal_debounce == 2 → Stop
    assert pub.events[-1] == {"event": "stop", "readerId": "primary", "at": "2026-07-21T00:00:00Z"}
    assert led.patterns[-1] is Pattern.IDLE
    assert app.status()["state"] == "idle"


def test_swap_publishes_stop_then_start():
    app, reader, pub, led = build()
    reader.set_tag("A", URI_A)
    app.tick()
    app.tick()  # PLAYING A
    reader.set_tag("B", URI_B)
    app.tick()  # swap_debounce == 1 → Swap
    assert [e["event"] for e in pub.events[-2:]] == ["stop", "start"]
    assert pub.events[-1]["uri"] == URI_B
    assert app.status()["lastUri"] == URI_B


def test_downstream_failure_lights_error():
    app, reader, pub, led = build(health={"conductor": False, "backdrop": True})
    reader.set_tag("A", URI_A)
    app.tick()
    app.tick()  # Start, but a downstream failed
    assert led.patterns[-1] is Pattern.ERROR
    assert app.status()["downstreamHealth"] == {"conductor": False, "backdrop": True}


def test_bad_tag_does_not_publish():
    app, reader, pub, led = build()
    reader.set_tag("A", "not-a-curator-uri")
    app.tick()
    app.tick()  # threshold → BadTag, no publish
    assert pub.events == []
    assert app.status()["state"] == "idle"


# --- /status observability (issue #198's blind spot) ---------------------------------------------
#
# `state`/`lastUid`/`lastUri` describe the *machine*, so they only ever populate once an album has
# started playing. A sleeve sitting on the reader being rejected — the case you actually need to
# diagnose — was invisible: the endpoint looked exactly like an empty stand. These fields describe
# the *reader* instead, so "is there a sleeve on it, and what does it read?" is answerable.


def test_status_reports_a_tag_that_is_present_but_undecodable():
    app, reader, pub, led = build()
    reader.set_tag("04:A1:B2", None)  # on the reader, NDEF unreadable
    app.tick()

    observed = app.status()["observed"]
    assert observed == {"uid": "04:A1:B2", "uri": None, "at": "2026-07-21T00:00:00Z"}
    # …and the machine still reports nothing, which is the whole point of the new field.
    assert app.status()["state"] == "idle"
    assert app.status()["lastUri"] is None


def test_status_reports_a_tag_carrying_the_wrong_kind_of_uri():
    app, reader, pub, led = build()
    reader.set_tag("A", "spotify:album:nope")
    app.tick()
    assert app.status()["observed"]["uri"] == "spotify:album:nope"


def test_status_shows_an_empty_stand_as_no_observation():
    app, reader, pub, led = build()
    reader.set_tag("A", URI_A)
    app.tick()
    assert app.status()["observed"] is not None
    reader.clear()
    app.tick()
    assert app.status()["observed"] is None  # sleeve lifted — nothing on the reader


def test_status_records_the_last_rejected_tag():
    app, reader, pub, led = build()
    assert app.status()["lastBadTag"] is None
    reader.set_tag("A", "not-a-curator-uri")
    app.tick()
    app.tick()  # threshold → BadTag
    assert app.status()["lastBadTag"] == {
        "uid": "A",
        "uri": "not-a-curator-uri",
        "at": "2026-07-21T00:00:00Z",
    }


def test_a_rejection_is_remembered_after_the_sleeve_is_lifted():
    # The forensic case: you take the sleeve off before thinking to check /status.
    app, reader, pub, led = build()
    reader.set_tag("A", None)
    app.tick()
    app.tick()  # BadTag
    reader.clear()
    app.tick()
    assert app.status()["observed"] is None  # nothing on the reader now…
    assert app.status()["lastBadTag"]["uid"] == "A"  # …but we still know what happened


def test_a_successful_scan_still_reports_the_observation():
    app, reader, pub, led = build()
    reader.set_tag("A", URI_A)
    app.tick()
    app.tick()  # Start
    assert app.status()["state"] == "playing"
    assert app.status()["observed"] == {
        "uid": "A",
        "uri": URI_A,
        "at": "2026-07-21T00:00:00Z",
    }


# --- poll-loop liveness (issue #308, ADR 0077) --------------------------------------------------


def test_every_tick_heartbeats():
    """The signal that separates a live loop from a wedged one — see stylus/watchdog.py."""
    beats = []
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=2, removal_debounce_polls=2))
    app = StylusApp(
        cfg, SimulatedReader(), FakePublisher(), RecordingLed(), heartbeat=lambda: beats.append(1)
    )
    for _ in range(3):
        app.tick()
    assert len(beats) == 3


def test_an_idle_tick_still_heartbeats():
    # An empty stand is the normal state. A heartbeat that only fired on activity would let a
    # perfectly healthy idle reader look dead to systemd.
    beats = []
    app = StylusApp(
        Config(), SimulatedReader(), FakePublisher(), RecordingLed(), heartbeat=lambda: beats.append(1)
    )
    app.tick()
    assert beats == [1]


def test_the_heartbeat_fires_before_the_reader_is_polled():
    """A tick that never returns must still have announced it *started*, or the gap between the
    previous beat and the hang eats into the deadline for no reason."""
    order = []

    class SlowReader:
        def poll(self):
            order.append("poll")
            return None

    app = StylusApp(
        Config(), SlowReader(), FakePublisher(), RecordingLed(), heartbeat=lambda: order.append("beat")
    )
    app.tick()
    assert order == ["beat", "poll"]


def test_heartbeat_defaults_to_a_no_op():
    # Every existing construction site (and every test above) omits it.
    app, reader, _, _ = build()
    reader.set_tag("A", URI_A)
    app.tick()  # must not raise


# --- publishing off the poll loop (issue #173, ADR 0078) ----------------------------------------


class QueueingPublisher:
    """A `QueuedPublisher` stand-in: accepts the event, reports only *previously* known health."""

    def __init__(self, health=None):
        self.events = []
        self._health = health or {}

    def publish(self, event):
        self.events.append(event)
        return dict(self._health)

    def stats(self):
        return {"depth": len(self.events), "dropped": 0}


def test_start_ack_blinks_on_acceptance_not_on_delivery():
    """§7's two blinks used to mean "published"; since #173 the result isn't known yet when the
    sleeve lands, so they mean "read and accepted". Waiting for delivery would put the blink
    seconds after the gesture, which reads as lag rather than acknowledgement."""
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=2, removal_debounce_polls=2))
    led = RecordingLed()
    reader = SimulatedReader()
    app = StylusApp(cfg, reader, QueueingPublisher(), led, now=lambda: "t")
    reader.set_tag("A", URI_A)
    app.tick()
    app.tick()  # → Start, queued but not yet delivered
    assert Pattern.START_ACK in led.patterns


def test_a_failure_from_an_earlier_publish_still_lights_the_error():
    # Health is now "last completed publish". It arrives a tick or two late, but it must still
    # reach the LED — that pattern is the only signal a downstream is unreachable.
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=1, removal_debounce_polls=2))
    led = RecordingLed()
    reader = SimulatedReader()
    app = StylusApp(cfg, reader, QueueingPublisher({"conductor": False}), led, now=lambda: "t")
    reader.set_tag("A", URI_A)
    app.tick()
    assert led.patterns[-1] is Pattern.ERROR


def test_status_reports_the_publish_backlog():
    # A queue that is quietly filling is the new failure mode this change introduces, so /status
    # has to be able to show it — otherwise "events are late" has no observable cause.
    app = StylusApp(Config(), SimulatedReader(), QueueingPublisher(), RecordingLed())
    app.tick()
    assert app.status()["publishQueue"] == {"depth": 0, "dropped": 0}


def test_status_omits_the_backlog_when_the_publisher_has_no_queue():
    # `--simulate` and the tests wire a plain publisher; asking it for stats must not explode.
    app, _, _, _ = build()
    assert app.status()["publishQueue"] is None


def test_a_stale_failure_does_not_suppress_the_ack_for_a_fresh_scan():
    """The sharp edge of "health is now the *last completed* publish": before #173 that health
    described the event being acked, so suppressing the blink on failure was right. Now it may
    describe some earlier event entirely — letting it veto this scan's blink would mean a stand
    that stops acknowledging you until the network recovers, for scans it accepted perfectly."""
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=1, removal_debounce_polls=2))
    led = RecordingLed()
    reader = SimulatedReader()
    app = StylusApp(cfg, reader, QueueingPublisher({"conductor": False}), led, now=lambda: "t")
    reader.set_tag("A", URI_A)
    app.tick()
    assert Pattern.START_ACK in led.patterns, "the scan was accepted; say so"
    assert led.patterns[-1] is Pattern.ERROR, "and still report the unhealthy downstream"
