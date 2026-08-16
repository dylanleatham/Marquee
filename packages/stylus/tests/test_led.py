import logging

import pytest

from stylus.led import (
    GpioLed,
    LoggingLed,
    NoopLed,
    Pattern,
    create_led,
    frames_for,
    is_one_shot,
)


class FakeDriver:
    """Records every brightness written, so a pattern is assertable without hardware."""

    def __init__(self) -> None:
        self.levels: list[float] = []
        self.closed = False

    def write(self, level: float) -> None:
        self.levels.append(level)

    def close(self) -> None:
        self.closed = True


def test_noop_led_does_nothing():
    NoopLed().set(Pattern.PLAYING)  # must not raise


def test_logging_led_logs_only_on_change(caplog):
    led = LoggingLed()
    with caplog.at_level(logging.INFO, logger="stylus.led"):
        led.set(Pattern.IDLE)
        led.set(Pattern.IDLE)  # unchanged → no second log
        led.set(Pattern.PLAYING)
    logged = [r.message for r in caplog.records if r.name == "stylus.led"]
    assert len(logged) == 2
    assert "idle" in logged[0] and "playing" in logged[1]


def test_create_led_toggles_impl():
    assert isinstance(create_led(True), LoggingLed)
    assert isinstance(create_led(False), NoopLed)


def test_create_led_with_gpio_pin_falls_back_to_logging_off_pi(caplog):
    # No Blinka on a workstation/CI — the LED must degrade, never stop Stylus from reading tags.
    with caplog.at_level(logging.WARNING, logger="stylus.led"):
        led = create_led(True, 17)
    assert isinstance(led, LoggingLed)
    assert any("LED disabled" in r.message for r in caplog.records)


def test_create_led_disabled_ignores_gpio_pin():
    assert isinstance(create_led(False, 17), NoopLed)


# --- frames (pure) ---------------------------------------------------------------------------------


def test_every_pattern_has_frames_with_sane_levels_and_holds():
    for pattern in Pattern:
        frames = frames_for(pattern)
        assert frames, f"{pattern} has no frames"
        for level, hold in frames:
            assert 0.0 <= level <= 1.0
            assert hold > 0


def test_idle_breathes_over_two_seconds():
    frames = frames_for(Pattern.IDLE)
    # §7: slow breathe, 2s cycle. Asserted with a tolerance, and that is not slack — the 40 holds are
    # each 1/20, which has no exact binary representation, so *how* far the sum lands from 2.0 is a
    # property of the interpreter rather than of the LED: CPython 3.12 gave the built-in `sum()`
    # compensated (Neumaier) summation and returns exactly 2.0, while 3.11 — the floor of
    # `requires-python`, and what CI runs — accumulates naively to 2.000000000000001. Pinning `== 2.0`
    # therefore passed on a dev workstation and failed on the only Python that actually ran it
    # (issue #194). A femtosecond of drift across a two-second breathe is not a defect; the cycle
    # length is what §7 specifies, so that is what this asserts.
    assert sum(hold for _, hold in frames) == pytest.approx(2.0)
    levels = [level for level, _ in frames]
    assert min(levels) == 0.0 and max(levels) == 1.0
    assert levels.index(max(levels)) == len(levels) // 2  # ramps up, then back down


def test_idle_cycle_holds_under_naive_summation():
    """The 2s cycle must hold under CPython <=3.11's `sum()`, not only 3.12+'s compensated one.

    This is the blind spot behind issue #194, not a restatement of the test above. CI pins 3.11 and
    `requires-python` floors there, but a workstation on 3.12+ gets the accurate built-in `sum()` —
    so a float-equality regression in the assertion above is green locally and red only in CI, where
    nobody is looking until a PR is already open. Adding the holds by hand reproduces the older
    interpreter's arithmetic on *any* interpreter, so the failure is now a local one.
    """
    total = 0.0
    for _, hold in frames_for(Pattern.IDLE):
        total += hold
    assert total == pytest.approx(2.0)


def test_playing_is_solid_and_error_blinks_at_100ms():
    assert all(level == 1.0 for level, _ in frames_for(Pattern.PLAYING))
    assert frames_for(Pattern.ERROR) == [(1.0, 0.1), (0.0, 0.1)]


def test_only_start_ack_is_one_shot():
    assert is_one_shot(Pattern.START_ACK)
    assert not any(is_one_shot(p) for p in Pattern if p is not Pattern.START_ACK)


# --- player ----------------------------------------------------------------------------------------


def _player(driver):
    return GpioLed(driver, sleep=lambda _: None, start_thread=False)


def test_play_once_writes_the_current_pattern():
    driver = FakeDriver()
    led = _player(driver)
    led.set(Pattern.ERROR)
    led.play_once()
    assert driver.levels == [1.0, 0.0]


def test_start_ack_plays_in_full_then_steady_resumes():
    # The app sets START_ACK and PLAYING in the same tick; the ack must still be visible.
    driver = FakeDriver()
    led = _player(driver)
    led.set(Pattern.START_ACK)
    led.set(Pattern.PLAYING)
    led.play_once()
    assert driver.levels == [1.0, 0.0, 1.0, 0.0]  # both blinks, uninterrupted
    driver.levels.clear()
    led.play_once()
    assert driver.levels == [1.0]  # then settles to solid


def test_a_steady_pattern_yields_as_soon_as_another_is_requested():
    driver = FakeDriver()
    holder: dict[str, GpioLed] = {}
    swapped: list[bool] = []

    def sleep(_):
        if not swapped:  # mid-frame, ask for a different pattern
            swapped.append(True)
            holder["led"].set(Pattern.PLAYING)

    led = GpioLed(driver, sleep=sleep, start_thread=False)
    holder["led"] = led
    led.set(Pattern.IDLE)  # 40 frames if it ran to completion
    led.play_once()
    assert len(driver.levels) == 1  # bailed out after the first frame, not 40


def test_close_turns_the_led_off_and_releases_the_pin():
    driver = FakeDriver()
    led = _player(driver)
    led.close()
    assert driver.levels[-1] == 0.0
    assert driver.closed


# --- the switched-off pattern ([ADR 0093]) ---------------------------------------------------------


def test_off_is_a_blip_not_darkness():
    """"Switched off" and "unpowered" must not look the same — a dark LED is what a dead stand
    shows, and the whole point of the indicator is telling you the stand is fine, just asleep."""
    frames = frames_for(Pattern.OFF)
    assert any(level > 0 for level, _ in frames)


def test_off_is_mostly_dark_so_it_cannot_be_mistaken_for_idle():
    frames = frames_for(Pattern.OFF)
    lit = sum(hold for level, hold in frames if level > 0)
    total = sum(hold for _, hold in frames)
    assert total > 3.0  # a long, slow cycle — nothing like IDLE's 2s breathe
    assert lit / total < 0.05


def test_off_yields_promptly_so_switching_back_on_looks_instant():
    """`GpioLed.play_once` only tests for interruption between frames, so a single 4s dark frame
    would leave the LED up to 4s behind the switch. No frame may be long enough to notice."""
    assert max(hold for _, hold in frames_for(Pattern.OFF)) <= 0.5


def test_off_is_not_a_one_shot():
    assert is_one_shot(Pattern.OFF) is False


def test_every_pattern_is_visually_distinct():
    """`frames_for` ends in an unguarded `return` for START_ACK, so a new Pattern member with no
    branch of its own silently inherits START_ACK's two blinks — a *wrong* indication rather than a
    crash, which nothing else here would flag. Asserting distinctness is what closes that: an
    indicator that duplicates another indicator conveys nothing either way."""
    seen: dict[tuple, Pattern] = {}
    for pattern in Pattern:
        frames = tuple(frames_for(pattern))
        assert frames, pattern
        assert frames not in seen, f"{pattern} is indistinguishable from {seen.get(frames)}"
        seen[frames] = pattern
