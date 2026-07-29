import logging

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
    assert sum(hold for _, hold in frames) == 2.0  # §7: slow breathe, 2s cycle
    levels = [level for level, _ in frames]
    assert min(levels) == 0.0 and max(levels) == 1.0
    assert levels.index(max(levels)) == len(levels) // 2  # ramps up, then back down


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
