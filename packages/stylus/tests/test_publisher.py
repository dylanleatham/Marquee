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
    pub, transport, _ = make(200)
    pub.publish(EVENT)
    call = transport.calls[0]
    assert call["headers"]["X-Trigger-Secret"] == "s"
    assert call["timeout_s"] == 1.0  # 1000ms default


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
