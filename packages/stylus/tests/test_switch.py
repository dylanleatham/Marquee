"""The stand's on/off switch ([ADR 0093])."""

import logging

import pytest

from stylus.switch import (
    AlwaysLive,
    GpioSwitch,
    SimulatedSwitch,
    create_switch,
)


class FakeDriver:
    """A pin whose level — and whether reading it works at all — the test controls."""

    def __init__(self, level=True):
        self.level = level
        self.raises = None
        self.closed = False
        self.reads = 0

    def read(self):
        self.reads += 1
        if self.raises is not None:
            raise self.raises
        return self.level

    def close(self):
        self.closed = True


# --- the no-switch and bench implementations -------------------------------------------------------


def test_always_live_is_live_and_names_itself():
    s = AlwaysLive()
    assert s.is_live() is True
    assert s.source == "none"


def test_always_live_carries_the_reason_it_fell_back():
    assert AlwaysLive(source="unavailable").source == "unavailable"


def test_simulated_switch_flips():
    s = SimulatedSwitch()
    assert s.is_live() is True
    s.set_live(False)
    assert s.is_live() is False
    assert s.source == "simulated"


def test_simulated_switch_can_start_off():
    assert SimulatedSwitch(live=False).is_live() is False


# --- the GPIO implementation -----------------------------------------------------------------------


def test_gpio_switch_reports_the_pin():
    d = FakeDriver(level=False)
    s = GpioSwitch(d)
    assert s.is_live() is False
    d.level = True
    assert s.is_live() is True
    assert s.source == "gpio"


def test_gpio_switch_reads_the_pin_every_time():
    """No caching: the whole point is that flipping the switch is noticed on the next poll."""
    d = FakeDriver()
    s = GpioSwitch(d)
    s.is_live()
    s.is_live()
    assert d.reads == 2


def test_unreadable_pin_holds_the_last_known_position():
    d = FakeDriver(level=False)
    s = GpioSwitch(d)
    assert s.is_live() is False
    d.raises = OSError("I2C bus error")
    # Still off — a fault must not silently re-arm a stand you deliberately switched off.
    assert s.is_live() is False
    assert s.is_live() is False


def test_a_pin_that_fails_from_the_very_first_read_is_live():
    """Fail *live*: a stand that refuses to react is indistinguishable from a broken one."""
    d = FakeDriver()
    d.raises = OSError("boom")
    assert GpioSwitch(d).is_live() is True


def test_the_switch_recovers_when_the_pin_comes_back():
    d = FakeDriver(level=False)
    s = GpioSwitch(d)
    s.is_live()
    d.raises = OSError("boom")
    s.is_live()
    d.raises = None
    d.level = True
    assert s.is_live() is True


def test_a_failing_pin_logs_once_not_every_poll(caplog):
    d = FakeDriver()
    s = GpioSwitch(d)
    s.is_live()
    d.raises = OSError("boom")
    with caplog.at_level(logging.WARNING, logger="stylus.switch"):
        for _ in range(5):
            s.is_live()
    assert len(caplog.records) == 1


def test_recovery_is_logged(caplog):
    d = FakeDriver()
    s = GpioSwitch(d)
    d.raises = OSError("boom")
    s.is_live()
    d.raises = None
    with caplog.at_level(logging.INFO, logger="stylus.switch"):
        s.is_live()
    assert "readable again" in caplog.text


def test_close_closes_the_driver():
    d = FakeDriver()
    GpioSwitch(d).close()
    assert d.closed


# --- the factory ------------------------------------------------------------------------------------


def test_disabled_switch_is_always_live():
    s = create_switch(False, 27, live_when_low=True)
    assert s.is_live() is True
    assert s.source == "none"


def test_missing_hardware_degrades_to_live_and_says_so(caplog):
    """Off-Pi (no Blinka) the factory must not raise — the reader is the product. But `source`
    has to distinguish this from a switch that is simply on, or the failure is invisible."""
    with caplog.at_level(logging.ERROR, logger="stylus.switch"):
        s = create_switch(True, 27, live_when_low=True)
    assert s.is_live() is True
    assert s.source == "unavailable"
    assert "stay live" in caplog.text


@pytest.mark.parametrize("live_when_low", [True, False])
def test_the_factory_never_raises_off_pi(live_when_low):
    assert create_switch(True, 27, live_when_low=live_when_low).is_live() is True
