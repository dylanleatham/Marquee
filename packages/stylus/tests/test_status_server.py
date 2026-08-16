import json
import threading
import pytest
import urllib.request

from stylus.app import StylusApp
from stylus.config import Config, ReaderConfig
from stylus.led import NoopLed
from stylus.reader import SimulatedReader
from stylus.status_server import StatusService, serve
from stylus.switch import SimulatedSwitch

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


# --- POST /switch, the bench counterpart of the physical switch ([ADR 0093]) ------------------------


def _service_with_sim_switch():
    sim_switch = SimulatedSwitch()
    app = StylusApp(
        Config(reader=ReaderConfig(insertion_debounce_polls=1, removal_debounce_polls=1)),
        SimulatedReader(),
        _NullPublisher(),
        NoopLed(),
        switch=sim_switch,
    )
    return StatusService(app, None, sim_switch), app, sim_switch


class _NullPublisher:
    def publish(self, event):
        return {}


def test_switch_flips_the_simulated_switch():
    svc, app, _ = _service_with_sim_switch()
    status, body = svc.handle("POST", "/switch", b'{"live": false}')
    assert status == 202
    assert body == {"switch": {"live": False}}
    app.tick()
    assert app.status()["switch"]["live"] is False


def test_switch_flips_back():
    svc, app, _ = _service_with_sim_switch()
    svc.handle("POST", "/switch", b'{"live": false}')
    svc.handle("POST", "/switch", b'{"live": true}')
    app.tick()
    assert app.status()["switch"]["live"] is True


def test_switch_is_refused_without_a_simulated_switch():
    """On the Pi the latching switch is the sole authority — there is nothing sane for HTTP to do
    but decline, since it cannot move the thing on the front of the stand."""
    app = StylusApp(Config(), SimulatedReader(), _NullPublisher(), NoopLed())
    status, body = StatusService(app).handle("POST", "/switch", b'{"live": false}')
    assert status == 409
    assert "physical" in body["error"]


def test_switch_rejects_a_missing_live_field():
    svc, _, _ = _service_with_sim_switch()
    status, body = svc.handle("POST", "/switch", b"{}")
    assert status == 400
    assert "live" in body["error"]


def test_switch_rejects_a_non_boolean_live():
    """`{"live": "false"}` is the obvious hand-typed mistake, and truthiness would make it mean the
    exact opposite of what was typed."""
    svc, _, _ = _service_with_sim_switch()
    status, _ = svc.handle("POST", "/switch", b'{"live": "false"}')
    assert status == 400


def test_switch_rejects_invalid_json():
    svc, _, _ = _service_with_sim_switch()
    status, _ = svc.handle("POST", "/switch", b"{oops")
    assert status == 400


def test_status_still_reports_the_switch_when_there_is_none():
    app = StylusApp(Config(), SimulatedReader(), _NullPublisher(), NoopLed())
    status, body = StatusService(app).handle("GET", "/status", b"")
    assert body["switch"] == {"live": True, "source": "none"}


# --- valid JSON that isn't an object -----------------------------------------------------------
#
# `json.loads` happily returns a list, a number, a string or None, none of which have `.get`. Both
# POST handlers called `.get` straight off the parse, so a body like `[1,2]` raised AttributeError
# out of `handle()` and killed that request's handler thread — a 500-with-no-body from a *bad
# request*, and one dead thread per attempt. Caught by the runtime reviewer on the /switch endpoint;
# /simulate had carried the same latent gap since it was written, so both are fixed at the shared
# parse step rather than one branch at a time.


@pytest.mark.parametrize("body", [b"[1,2]", b"42", b'"hi"', b"null", b"true"])
def test_switch_rejects_valid_json_that_is_not_an_object(body):
    svc, _, _ = _service_with_sim_switch()
    status, payload = svc.handle("POST", "/switch", body)
    assert status == 400
    assert "object" in payload["error"]


@pytest.mark.parametrize("body", [b"[1,2]", b"42", b'"hi"', b"null", b"true"])
def test_simulate_rejects_valid_json_that_is_not_an_object(body):
    sim = SimulatedReader()
    app = StylusApp(Config(), sim, _NullPublisher(), NoopLed())
    status, payload = StatusService(app, sim).handle("POST", "/simulate", body)
    assert status == 400
    assert "object" in payload["error"]
