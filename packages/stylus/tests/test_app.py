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
