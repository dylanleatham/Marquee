import logging

from stylus.led import LoggingLed, NoopLed, Pattern, create_led


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
