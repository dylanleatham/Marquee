"""Status LED (stylus-spec §7).

The app speaks in *semantic* patterns — idle, playing, error, start-ack, off — not raw GPIO. Three
implementations behind one seam, so the app loop is identical everywhere:

* :class:`NoopLed` — the LED is disabled in config.
* :class:`LoggingLed` — the bench: logs each pattern change so you can watch state transitions
  without hardware.
* :class:`GpioLed` — the Pi: plays each pattern's frames on a background thread against an
  injectable :class:`LedDriver`. The *frames* (:func:`frames_for`) are pure and tested; only the
  driver touches GPIO.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from enum import Enum
from typing import Protocol

log = logging.getLogger("stylus.led")


class Pattern(Enum):
    IDLE = "idle"  # slow breathe (2s)
    PLAYING = "playing"  # solid on
    ERROR = "error"  # fast blink (downstream post failed)
    START_ACK = "start_ack"  # two short blinks: "I heard you"
    OFF = "off"  # one short blip every 4s: the stand is switched off but alive


class Led(Protocol):
    def set(self, pattern: Pattern) -> None:
        ...


class NoopLed:
    """Does nothing — used when the LED is disabled in config."""

    def set(self, pattern: Pattern) -> None:  # noqa: D401
        pass


class LoggingLed:
    """Bench LED: logs each pattern change so you can watch state transitions without hardware."""

    def __init__(self) -> None:
        self._last: Pattern | None = None

    def set(self, pattern: Pattern) -> None:
        if pattern is not self._last:
            log.info("LED → %s", pattern.value)
            self._last = pattern


# --- patterns as frames (pure) ---------------------------------------------------------------------

# One frame = (brightness 0.0–1.0, how long to hold it in seconds). A pattern is a frame list the
# player repeats; a *one-shot* pattern plays through exactly once and then reverts to the steady one.
Frame = tuple[float, float]

_BREATHE_STEPS = 20  # 20 steps over a 2s cycle = 100ms each, smooth enough at arm's length


def _breathe() -> list[Frame]:
    """A 2s triangle ramp 0→1→0, as discrete brightness steps (stylus-spec §7 'slow breathe')."""
    up = [(i / _BREATHE_STEPS, 1.0 / _BREATHE_STEPS) for i in range(_BREATHE_STEPS)]
    down = [(1.0 - level, hold) for level, hold in up]
    return up + down


def frames_for(pattern: Pattern) -> list[Frame]:
    """The frame list for a pattern. Pure — this is the tested part of the LED."""
    if pattern is Pattern.IDLE:
        return _breathe()
    if pattern is Pattern.PLAYING:
        return [(1.0, 0.5)]  # solid; re-asserted twice a second so a pattern change lands fast
    if pattern is Pattern.ERROR:
        return [(1.0, 0.1), (0.0, 0.1)]  # fast blink, 100ms per §7
    if pattern is Pattern.OFF:
        # One brief blip, then ~4s dark: unmistakably not IDLE's continuous breathe, and — the point
        # — not a dark LED either, which is what an unpowered stand looks like. "Switched off" and
        # "dead" must not be the same indication.
        #
        # The dark stretch is eight 0.5s frames rather than one 4s frame because `play_once` only
        # tests for interruption between frames: a single long frame would leave the LED up to 4s
        # behind the switch, so flipping the stand back on would look like it hadn't worked.
        return [(1.0, 0.05)] + [(0.0, 0.5)] * 8
    # START_ACK — two short blinks then off.
    return [(1.0, 0.08), (0.0, 0.08), (1.0, 0.08), (0.0, 0.08)]


def is_one_shot(pattern: Pattern) -> bool:
    """START_ACK plays to completion once, then the steady pattern resumes.

    Without this the ack would never be visible: ``StylusApp._handle`` sets START_ACK and
    ``_apply_steady_led`` overwrites it with PLAYING microseconds later, in the same tick.
    """
    return pattern is Pattern.START_ACK


class LedDriver(Protocol):
    """The only part that touches hardware: set the LED to a brightness in 0.0–1.0."""

    def write(self, level: float) -> None:
        ...

    def close(self) -> None:
        ...


class GpioLed:
    """Plays patterns on a background thread. ``driver``/``sleep`` are injectable for tests."""

    def __init__(
        self,
        driver: LedDriver,
        *,
        sleep: Callable[[float], None] = time.sleep,
        start_thread: bool = True,
    ) -> None:
        self._driver = driver
        self._sleep = sleep
        self._lock = threading.Lock()
        self._steady = Pattern.IDLE
        self._pending_one_shot: Pattern | None = None
        self._running = True
        self._thread: threading.Thread | None = None
        if start_thread:
            self._thread = threading.Thread(target=self.run, name="stylus-led", daemon=True)
            self._thread.start()

    def set(self, pattern: Pattern) -> None:
        with self._lock:
            if is_one_shot(pattern):
                self._pending_one_shot = pattern
            else:
                self._steady = pattern

    def run(self) -> None:
        while self._running:
            self.play_once()

    def play_once(self) -> None:
        """Play one pass of the current pattern. Split out so tests can step it deterministically."""
        with self._lock:
            one_shot = self._pending_one_shot
            self._pending_one_shot = None
            pattern = one_shot or self._steady
        interruptible = one_shot is None
        for level, hold in frames_for(pattern):
            if not self._running:
                return
            self._driver.write(level)
            self._sleep(hold)
            # A steady pattern yields the moment something else is asked for; a one-shot finishes.
            if interruptible and self._interrupted(pattern):
                return

    def _interrupted(self, playing: Pattern) -> bool:
        with self._lock:
            return self._pending_one_shot is not None or self._steady is not playing

    def close(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._driver.write(0.0)
        self._driver.close()


def create_gpio_driver(gpio_pin: int) -> LedDriver:  # pragma: no cover - hardware path
    """Build the real GPIO driver via Blinka. Raises a clear error off-Pi.

    Prefers ``pwmio`` so the breathe ramp is a real fade. Blinka's PWM is software-timed and not
    available on every board/backend, so we fall back to a plain on/off ``digitalio`` pin — the
    breathe then reads as a slow blink, which is a cosmetic downgrade, not a broken LED.
    """
    try:
        import board  # type: ignore
        import digitalio  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            f"GPIO libraries not available — the LED only runs on the Pi. Install the hardware "
            f"extra (pip install '.[hardware]') or set [led].enabled = false. ({e})"
        ) from e

    pin = getattr(board, f"D{gpio_pin}")

    try:
        import pwmio  # type: ignore

        pwm = pwmio.PWMOut(pin, frequency=200, duty_cycle=0)

        class _PwmDriver:
            def write(self, level: float) -> None:
                pwm.duty_cycle = int(max(0.0, min(1.0, level)) * 65535)

            def close(self) -> None:
                pwm.deinit()

        log.info("LED on GPIO %d (PWM)", gpio_pin)
        return _PwmDriver()
    except Exception as e:  # noqa: BLE001 — any PWM failure degrades to on/off, never kills Stylus
        log.warning("LED PWM unavailable on GPIO %d (%s) — falling back to on/off", gpio_pin, e)

    out = digitalio.DigitalInOut(pin)
    out.direction = digitalio.Direction.OUTPUT

    class _DigitalDriver:
        def write(self, level: float) -> None:
            out.value = level >= 0.5

        def close(self) -> None:
            out.deinit()

    return _DigitalDriver()


def create_led(enabled: bool, gpio_pin: int | None = None) -> Led:
    """Build the LED for this host.

    With ``gpio_pin`` set we try the real GPIO driver and **fall back to logging** if the hardware
    libraries aren't there — so the same config works on the bench and on the Pi, and a missing
    Blinka never stops Stylus from reading tags.
    """
    if not enabled:
        return NoopLed()
    if gpio_pin is None:
        return LoggingLed()
    try:
        return GpioLed(create_gpio_driver(gpio_pin))
    except Exception as e:  # noqa: BLE001 — the LED is a nicety; the reader is the product
        log.warning("LED disabled: %s", e)
        return LoggingLed()
