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
