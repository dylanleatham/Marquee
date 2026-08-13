"""Bounding a call that can hang (stylus-spec §12, [ADR 0076], issue #307).

The bug these guard: the one-time PN532 init had no bound on any of its four calls — ``busio.I2C``,
``PN532_I2C``, ``SAM_configuration``, ``configure_tx_drive``. A wedged module blocks one of them
forever, and a blocked process is not a dead process, so the unit's ``Restart=always`` never fires.
The service sits at ``active (running)`` with a silent journal, reading nothing, until someone SSHs
in. DEPLOY.md §12 documented that symptom long before anything recovered from it.

The init itself is a ``# pragma: no cover`` hardware seam, so — per #170/#174/#176/#232/#303, every
one of which was a defect that lived in exactly such a seam — the bounding logic lives here as
injectable functions, and what's tested is the *composition*: that all four hang sites are inside
the bound, with a fake that hangs on each in turn.

No test may actually exit the process, so ``run_or_die`` takes its exit hook. That is also the only
way to assert on the interesting part — that it exits at all, with a non-zero code.
"""

import logging
import threading
import time

import pytest

from stylus.bounded import Hung, call_with_timeout, run_or_die
from stylus.config import RfConfig
from stylus.reader import open_pn532_reader

# Comfortably longer than any bound under test, but short enough that a genuine deadlock fails the
# suite in seconds rather than hanging CI.
PATIENCE = 5.0


class _Blocker:
    """A callable that parks until released. ``release()`` in a finally, or the thread leaks."""

    def __init__(self) -> None:
        self._go = threading.Event()
        self.entered = threading.Event()

    def __call__(self, *args, **kwargs):
        self.entered.set()
        self._go.wait(PATIENCE)
        return None

    def release(self) -> None:
        self._go.set()


@pytest.fixture
def blocker():
    b = _Blocker()
    try:
        yield b
    finally:
        b.release()


class _RecordingExit:
    """Stands in for ``os._exit``. Records instead of exiting so the test survives to assert."""

    def __init__(self) -> None:
        self.codes: list[int] = []

    def __call__(self, code: int) -> None:
        self.codes.append(code)


# --- the helper ---------------------------------------------------------------------------------


def test_a_call_that_finishes_returns_its_value():
    assert call_with_timeout(lambda: "pn532", PATIENCE, stage="init") == "pn532"


def test_a_call_that_raises_propagates_the_original_exception():
    # An init that *fails* is already handled: the exception kills the process and Restart=always
    # brings it back. Only a hang needs the bound, so ordinary errors must pass through untouched.
    def work():
        raise RuntimeError("no module named 'board'")

    with pytest.raises(RuntimeError, match="board"):
        call_with_timeout(work, PATIENCE, stage="init")


def test_a_call_that_hangs_raises_hung(blocker):
    with pytest.raises(Hung):
        call_with_timeout(blocker, 0.05, stage="init")


def test_hung_names_the_stage_and_the_bound_it_broke(blocker):
    # This message is the whole diagnostic. Without it the journal shows a restart and no reason.
    with pytest.raises(Hung) as caught:
        call_with_timeout(blocker, 0.05, stage="PN532 init")
    assert caught.value.stage == "PN532 init"
    assert "PN532 init" in str(caught.value)
    assert "0.05" in str(caught.value)


def test_a_hang_gives_up_at_the_bound_rather_than_waiting_for_the_call(blocker):
    started = time.monotonic()
    with pytest.raises(Hung):
        call_with_timeout(blocker, 0.05, stage="init")
    # The blocker parks for PATIENCE. Returning near the bound is the proof we stopped waiting on
    # it, rather than being handed control back when it happened to finish.
    assert time.monotonic() - started < PATIENCE / 2


def test_the_work_runs_on_a_daemon_thread():
    # The hung call is blocked in a C-level I²C ioctl and cannot be interrupted. A non-daemon
    # thread would be joined at interpreter shutdown, so the process that tried to die of a hang
    # would hang on the way out — turning the fix into the bug.
    seen = {}

    def work():
        seen["daemon"] = threading.current_thread().daemon

    call_with_timeout(work, PATIENCE, stage="init")
    assert seen["daemon"] is True


# --- the exit backstop --------------------------------------------------------------------------


def test_run_or_die_passes_a_good_result_through_without_exiting():
    exit_ = _RecordingExit()
    assert run_or_die(lambda: "reader", PATIENCE, stage="init", exit_=exit_) == "reader"
    assert exit_.codes == []


def test_run_or_die_exits_non_zero_on_a_hang(blocker):
    exit_ = _RecordingExit()
    with pytest.raises(Hung):
        run_or_die(blocker, 0.05, stage="init", exit_=exit_)
    assert exit_.codes == [1], "systemd Restart=always only recovers a process that actually exits"


def test_run_or_die_does_not_exit_on_an_ordinary_exception():
    # Restart=always already covers a crash. Routing crashes through os._exit would skip the
    # traceback, which is the only thing that says *why* in journalctl.
    exit_ = _RecordingExit()

    def work():
        raise RuntimeError("i2c permission denied")

    with pytest.raises(RuntimeError, match="permission"):
        run_or_die(work, PATIENCE, stage="init", exit_=exit_)
    assert exit_.codes == []


def test_run_or_die_logs_why_before_it_exits(blocker, caplog):
    # os._exit skips atexit and buffered output, so a message logged after it would never reach
    # journald. A restart with no explanation is the failure this issue is about, one level up.
    exit_ = _RecordingExit()
    with caplog.at_level(logging.CRITICAL), pytest.raises(Hung):
        run_or_die(blocker, 0.05, stage="PN532 init", exit_=exit_)
    assert any(
        r.levelno >= logging.CRITICAL and "PN532 init" in r.getMessage() for r in caplog.records
    )


# --- the composition: every hang site is inside the bound ---------------------------------------


class _FakeChip:
    """A PN532 that can be told to hang on any one step of the setup sequence."""

    def __init__(self, hang_on: str | None = None, blocker: _Blocker | None = None) -> None:
        self._hang_on = hang_on
        self._blocker = blocker
        self.calls: list[str] = []

    def _step(self, name: str) -> None:
        self.calls.append(name)
        if name == self._hang_on and self._blocker is not None:
            self._blocker()

    def SAM_configuration(self) -> None:  # noqa: N802 - mirrors the adafruit driver's name
        self._step("SAM")

    def call_function(self, command, params=None, response_length=0):
        self._step("call")
        return b""

    def read_passive_target(self, timeout=0.05):
        return None

    def ntag2xx_read_block(self, page):
        return None


def test_a_healthy_init_returns_a_working_reader():
    chip = _FakeChip()
    reader = open_pn532_reader(lambda: chip, RfConfig(), init_timeout_s=PATIENCE)
    assert reader.poll() is None
    assert chip.calls == ["SAM", "call"], "the bound must not disturb the setup sequence"


def test_a_hang_constructing_the_chip_exits(blocker):
    """``busio.I2C`` / ``PN532_I2C`` — the two DEPLOY.md §12 names, and the two that sit *outside*
    ``build_pn532_reader``. Bounding only the setup sequence would leave these open."""
    exit_ = _RecordingExit()
    with pytest.raises(Hung):
        open_pn532_reader(blocker, RfConfig(), init_timeout_s=0.05, exit_=exit_)
    assert exit_.codes == [1]


def test_a_hang_in_sam_configuration_exits(blocker):
    exit_ = _RecordingExit()
    chip = _FakeChip(hang_on="SAM", blocker=blocker)
    with pytest.raises(Hung):
        open_pn532_reader(lambda: chip, RfConfig(), init_timeout_s=0.05, exit_=exit_)
    assert exit_.codes == [1]


def test_a_hang_configuring_the_tx_drive_exits(blocker):
    """The fourth call, added by #305 and left unbounded there — bounding only it would have been
    worse than bounding none, so it waited for the other three."""
    exit_ = _RecordingExit()
    chip = _FakeChip(hang_on="call", blocker=blocker)
    with pytest.raises(Hung):
        open_pn532_reader(lambda: chip, RfConfig(), init_timeout_s=0.05, exit_=exit_)
    assert exit_.codes == [1]


def test_the_init_bound_names_the_stage_so_the_journal_says_what_hung(blocker):
    with pytest.raises(Hung) as caught:
        open_pn532_reader(blocker, RfConfig(), init_timeout_s=0.05, exit_=_RecordingExit())
    assert "PN532" in str(caught.value)
