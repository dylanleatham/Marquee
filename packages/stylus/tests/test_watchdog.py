"""systemd liveness notification (stylus-spec §12, [ADR 0077], issue #308).

The bug these guard: [#307](https://github.com/dylanleatham/Marquee/issues/307) bounded the one-time
init, so a hang *there* becomes a restart. A hang in the **poll loop** — mid `read_passive_target`,
or in an `ntag2xx_read_block` during an NDEF read — still blocked forever, with the same outward
symptom: `active (running)`, silent journal, no reads, and `Restart=` never firing because nothing
died.

The fix is a liveness signal rather than a one-shot bound, and its whole risk is the false positive:
kill a healthy Stylus and you've manufactured an outage out of an unrelated one.

That risk used to be acute. A tick blocked for tens of seconds whenever a downstream was down (§8's
retry window), so #308 shipped with the heartbeat threaded through the publisher's retry loop to
stop a *Conductor* outage reading as a Stylus hang.
[#173](https://github.com/dylanleatham/Marquee/issues/173) then moved publishing onto a worker
thread, which removed both the stall and that workaround — and inverted the hazard, because a
heartbeat on the worker would now let a healthy publisher mask a wedged reader. So the poll loop is
the **only** heartbeat source, `Publisher` no longer accepts one, and the tests below pin that as
well as the timing.

``os.environ`` and the real ``AF_UNIX`` socket are the seams; both are injected, so the protocol is
testable on a machine with no systemd (and on Windows, where ``AF_UNIX`` datagrams don't exist).
"""

import inspect
import os
import pathlib
import tomllib

import pytest

from stylus.publisher import Publisher
from stylus.watchdog import Watchdog, notify_address, socket_sender, watchdog_interval_s


class RecordingSend:
    """Stands in for the datagram to systemd. ``fail`` raises the given error instead of sending."""

    def __init__(self, fail: BaseException | None = None) -> None:
        self.sent: list[bytes] = []
        self._fail = fail

    def __call__(self, msg: bytes) -> None:
        if self._fail is not None:
            raise self._fail
        self.sent.append(msg)


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


# --- reading the environment systemd hands us ---------------------------------------------------


@pytest.mark.parametrize("raw", [None, ""])
def test_no_notify_socket_means_nobody_is_listening(raw):
    # The bench, `--simulate`, and any run outside systemd. Must be silent, not an error.
    assert notify_address(raw) is None


def test_a_filesystem_notify_socket_is_used_as_is():
    assert notify_address("/run/systemd/notify") == "/run/systemd/notify"


def test_an_abstract_notify_socket_gets_its_leading_nul_back():
    # systemd writes the abstract namespace's NUL as '@'. Send to a literal '@…' and the datagram
    # goes nowhere, silently — the failure mode is a watchdog that never pings and kills the service.
    assert notify_address("@/org/freedesktop/systemd1/notify") == "\0/org/freedesktop/systemd1/notify"


def test_no_watchdog_usec_means_no_pings():
    assert watchdog_interval_s({}) is None


def test_the_ping_interval_is_half_the_deadline():
    # Pinging *at* the deadline races the kill. Half is the sd_notify convention.
    assert watchdog_interval_s({"WATCHDOG_USEC": "30000000"}) == 15.0


def test_the_interval_is_ignored_when_watchdog_pid_names_another_process():
    # systemd sets WATCHDOG_PID so a forked child doesn't ping on the main process's behalf.
    assert watchdog_interval_s({"WATCHDOG_USEC": "30000000", "WATCHDOG_PID": "1"}) is None


def test_the_interval_applies_when_watchdog_pid_is_us():
    env = {"WATCHDOG_USEC": "30000000", "WATCHDOG_PID": str(os.getpid())}
    assert watchdog_interval_s(env) == 15.0


@pytest.mark.parametrize("usec", ["", "not-a-number", "0", "-1"])
def test_an_unusable_watchdog_usec_disables_pings_rather_than_crashing(usec):
    # A bad value must not take the service down — no watchdog is a degradation, not a failure.
    assert watchdog_interval_s({"WATCHDOG_USEC": usec}) is None


def test_socket_sender_without_an_address_is_a_silent_no_op():
    send = socket_sender(None)
    assert send(b"READY=1") is None  # must not raise: this is the bench path


# --- the notifications --------------------------------------------------------------------------


def test_ready_tells_systemd_startup_finished():
    # Type=notify hangs the unit in "activating" until this arrives, then kills it at
    # TimeoutStartSec. Forgetting it turns a working service into a failed one.
    rec = RecordingSend()
    Watchdog(rec, 15.0).ready()
    assert rec.sent == [b"READY=1"]


def test_ready_is_sent_even_with_no_watchdog_configured():
    # WatchdogSec= and Type=notify are independent knobs; READY=1 is owed either way.
    rec = RecordingSend()
    Watchdog(rec, None).ready()
    assert rec.sent == [b"READY=1"]


def test_the_first_ping_goes_out_immediately():
    rec = RecordingSend()
    Watchdog(rec, 15.0, monotonic=Clock()).ping()
    assert rec.sent == [b"WATCHDOG=1"]


def test_pings_are_rate_limited_to_the_interval():
    # The loop polls at 5Hz. Un-throttled that's 5 datagrams a second, forever, for a signal
    # systemd only needs twice a minute.
    rec, clock = RecordingSend(), Clock()
    dog = Watchdog(rec, 15.0, monotonic=clock)
    dog.ping()
    for _ in range(50):
        clock.t += 0.2
        dog.ping()
    assert rec.sent == [b"WATCHDOG=1"]  # 10s of polling, still inside the window


def test_a_ping_goes_out_again_once_the_interval_has_passed():
    rec, clock = RecordingSend(), Clock()
    dog = Watchdog(rec, 15.0, monotonic=clock)
    dog.ping()
    clock.t = 15.0
    dog.ping()
    assert rec.sent == [b"WATCHDOG=1", b"WATCHDOG=1"]


def test_no_watchdog_configured_means_ping_sends_nothing():
    rec = RecordingSend()
    dog = Watchdog(rec, None, monotonic=Clock())
    for _ in range(10):
        dog.ping()
    assert rec.sent == []


@pytest.mark.parametrize(
    "error",
    [
        OSError("no such socket"),
        # The socket is non-blocking precisely so a full receive buffer can't stall the poll loop
        # it's meant to be proving alive; the cost is that a ping can be refused. Dropping one is
        # safe — we send at half the deadline — but it must not surface as an exception.
        BlockingIOError("would block"),
    ],
)
def test_a_failing_socket_never_reaches_the_poll_loop(error):
    # The watchdog is a health signal, not the product. If notifying systemd fails, Stylus keeps
    # reading sleeves — an exception here would turn a cosmetic fault into the outage it reports.
    dog = Watchdog(RecordingSend(fail=error), 15.0, monotonic=Clock())
    dog.ready()
    dog.ping()  # must not raise


# --- the unit file and the code have to agree ---------------------------------------------------


def _unit() -> dict[str, str]:
    """`marquee-stylus.service` as a flat key→value map (last wins, which is systemd's rule)."""
    path = pathlib.Path(__file__).resolve().parents[1] / "marquee-stylus.service"
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "[")) and "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def test_the_unit_is_type_notify_because_the_code_sends_ready():
    # These two are one decision in two files. `Type=simple` with a READY=1 nobody reads is
    # harmless; `Type=notify` without one leaves the unit stuck in `activating` until it's killed.
    assert _unit()["Type"] == "notify"


def test_the_unit_arms_the_watchdog():
    assert int(_unit()["WatchdogSec"]) > 0


def test_watchdogsec_clears_the_slowest_legitimate_gap_between_heartbeats():
    """The false-positive guard, as arithmetic instead of a comment.

    Stylus pings at `WatchdogSec/2`, so the longest gap between heartbeat *calls* must stay under
    half the deadline, or systemd kills a perfectly healthy service.

    **This bound got much easier in #173.** The heartbeat used to have to survive a whole publish —
    the poll loop beat once per tick and the publisher once per attempt, so the gap was a downstream
    `timeout_ms` plus a retry delay, and raising a timeout could silently break it. Publishing now
    happens on a worker thread, so the only beat is the one at the top of `tick()` and the gap is
    one poll interval plus the reader's own work. Config no longer participates: the assertion below
    reads `poll_interval_ms` rather than `timeout_ms`, which is the whole point of the change.
    """
    example = pathlib.Path(__file__).resolve().parents[1] / "config.example.toml"
    cfg = tomllib.loads(example.read_text(encoding="utf-8"))
    poll_s = cfg["reader"]["poll_interval_ms"] / 1000
    # A full NDEF read is ~40 pages × 3 attempts of a few ms each; a second is generous for it.
    worst_gap_s = poll_s + 1.0

    assert int(_unit()["WatchdogSec"]) / 2 > worst_gap_s, (
        f"heartbeats can be {worst_gap_s}s apart, but the ping interval is "
        f"{int(_unit()['WatchdogSec']) / 2}s — raise WatchdogSec in marquee-stylus.service"
    )


def test_the_publisher_is_not_a_heartbeat_source():
    """The other half of the #173 change, and the one that would rot quietly.

    Moving publishing to a worker thread means a heartbeat inside it would be sent while the reader
    is wedged — a healthy publisher masking a dead poll loop, which is precisely what ADR 0077 is
    for. `test_publisher.py` guards the constructor; this states the rule where the watchdog's own
    invariants live, so anyone tightening WatchdogSec here meets it.
    """
    assert "heartbeat" not in inspect.signature(Publisher.__init__).parameters
