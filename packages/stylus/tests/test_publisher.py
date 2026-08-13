import json

from stylus.config import Downstream
from stylus.publisher import Publisher


class FakeTransport:
    """Returns queued responses per call: an int status, or an Exception to raise (network fail)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, body, headers, timeout_s):
        self.calls.append(
            {"url": url, "json": json.loads(body), "headers": dict(headers), "timeout_s": timeout_s}
        )
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def make(*responses, downstreams=None):
    slept = []
    transport = FakeTransport(*responses)
    dss = downstreams or [Downstream("conductor", "http://c/api/scan", shared_secret="s")]
    pub = Publisher(dss, transport=transport, sleep=slept.append)
    return pub, transport, slept


EVENT = {"event": "start", "uri": "curator:album:2k7bxq9m", "at": "t"}


def test_delivers_on_first_2xx_no_retry():
    pub, transport, slept = make(202)
    assert pub.publish(EVENT) == {"conductor": True}
    assert len(transport.calls) == 1
    assert slept == []  # no delay before the first attempt


def test_sends_shared_secret_header_and_timeout():
    # The point here is the ms→seconds conversion, so set it explicitly rather than pinning the
    # default a second time — test_config owns that (it moved 1000→3000 for the Hue round-trip).
    pub, transport, _ = make(
        200,
        downstreams=[Downstream("conductor", "http://c/api/scan", timeout_ms=1500, shared_secret="s")],
    )
    pub.publish(EVENT)
    call = transport.calls[0]
    assert call["headers"]["X-Trigger-Secret"] == "s"
    assert call["timeout_s"] == 1.5


def test_omits_secret_header_when_unset():
    pub, transport, _ = make(200, downstreams=[Downstream("backdrop", "http://b/api/scan")])
    pub.publish(EVENT)
    assert "X-Trigger-Secret" not in transport.calls[0]["headers"]


def test_retries_on_5xx_then_succeeds():
    pub, transport, slept = make(503, 200)
    assert pub.publish(EVENT) == {"conductor": True}
    assert len(transport.calls) == 2
    assert slept == [0.5]  # waited before the 2nd attempt


def test_retries_on_network_error():
    pub, transport, slept = make(ConnectionError("refused"), 204)
    assert pub.publish(EVENT) == {"conductor": True}
    assert len(transport.calls) == 2


def test_gives_up_after_three_attempts():
    pub, transport, slept = make(500, 500, 500)
    assert pub.publish(EVENT) == {"conductor": False}
    assert len(transport.calls) == 3
    assert slept == [0.5, 2.0]  # the two inter-attempt waits from §8


def test_fans_out_to_all_downstreams():
    ds = [Downstream("conductor", "http://c/api/scan"), Downstream("backdrop", "http://b/api/scan")]
    pub, transport, _ = make(200, 500, 500, 500, downstreams=ds)
    result = pub.publish(EVENT)
    assert result == {"conductor": True, "backdrop": False}
    assert [c["url"] for c in transport.calls][0] == "http://c/api/scan"


# --- poll-loop liveness during a slow publish (issue #308, ADR 0077) ----------------------------


def test_heartbeats_before_every_attempt():
    """The regression this exists to prevent: `publish` runs *inside* the poll tick, and a total
    downstream outage stalls it for tens of seconds (#173). A watchdog fed only once per tick would
    read that as a hang and kill Stylus — which does nothing for a downed Conductor. Beating between
    attempts is what makes a tight WatchdogSec safe."""
    beats = []
    transport = FakeTransport(OSError("refused"), OSError("refused"), OSError("refused"))
    pub = Publisher(
        [Downstream("conductor", "http://c/api/scan")],
        transport=transport,
        sleep=lambda _: None,
        heartbeat=lambda: beats.append(1),
    )
    assert pub.publish(EVENT) == {"conductor": False}
    assert len(transport.calls) == 3
    assert len(beats) == 3, "one before each attempt, so the gap is a single transport timeout"


def test_heartbeats_for_every_downstream_not_just_the_first():
    beats = []
    pub = Publisher(
        [Downstream("conductor", "http://c/"), Downstream("backdrop", "http://b/")],
        transport=FakeTransport(200, 200),
        sleep=lambda _: None,
        heartbeat=lambda: beats.append(1),
    )
    pub.publish(EVENT)
    assert len(beats) == 2


def test_heartbeat_defaults_to_a_no_op():
    pub, _, _ = make(200)
    assert pub.publish(EVENT) == {"conductor": True}  # must not raise
