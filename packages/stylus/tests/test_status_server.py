import json
import threading
import urllib.request

from stylus.app import StylusApp
from stylus.config import Config, ReaderConfig
from stylus.led import NoopLed
from stylus.reader import SimulatedReader
from stylus.status_server import StatusService, serve

URI = "curator:album:2k7bxq9m"


class FakePublisher:
    def __init__(self):
        self.events = []

    def publish(self, event):
        self.events.append(event)
        return {"conductor": True}


def build(with_sim=True):
    cfg = Config(reader=ReaderConfig(insertion_debounce_polls=1))
    reader = SimulatedReader()
    app = StylusApp(cfg, reader, FakePublisher(), NoopLed(), now=lambda: "t")
    svc = StatusService(app, reader if with_sim else None)
    return svc, app, reader


def test_healthz():
    svc, _, _ = build()
    assert svc.handle("GET", "/healthz", b"") == (200, {"ok": True})


def test_status_reports_state():
    svc, _, _ = build()
    status, body = svc.handle("GET", "/status", b"")
    assert status == 200 and body["state"] == "idle" and body["readerId"] == "primary"


def test_simulate_injects_a_tag_that_the_next_tick_picks_up():
    svc, app, reader = build()
    status, body = svc.handle("POST", "/simulate", json.dumps({"uid": "A", "uri": URI}).encode())
    assert status == 202
    app.tick()  # insertion_debounce == 1 → Start
    assert app.status()["state"] == "playing"


def test_simulate_clear_lifts_the_sleeve():
    svc, app, reader = build()
    reader.set_tag("A", URI)
    status, body = svc.handle("POST", "/simulate", b'{"clear": true}')
    assert status == 202 and reader.poll() is None


def test_simulate_requires_uid():
    svc, _, _ = build()
    status, body = svc.handle("POST", "/simulate", b"{}")
    assert status == 400


def test_simulate_unavailable_without_simulated_reader():
    svc, _, _ = build(with_sim=False)
    status, _ = svc.handle("POST", "/simulate", b'{"uid": "A"}')
    assert status == 409


def test_unknown_route_404():
    svc, _, _ = build()
    assert svc.handle("GET", "/nope", b"")[0] == 404


def test_real_http_round_trip():
    svc, app, _ = build()
    server = serve(svc, 0)  # ephemeral port
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=2) as resp:
            assert resp.status == 200
            assert json.loads(resp.read())["state"] == "idle"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/simulate",
            data=json.dumps({"uid": "A", "uri": URI}).encode(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            assert resp.status == 202
    finally:
        server.shutdown()
