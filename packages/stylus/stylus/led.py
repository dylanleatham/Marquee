"""Status LED (stylus-spec §7).

The app speaks in *semantic* patterns — idle, playing, error, start-ack — not raw GPIO. On the bench
we log the pattern (or record it, in tests); the real GPIO/PWM driver (breathe, solid, blink) is a
Pi-only concern wired in step 11. Keeping the seam at the semantic level means the app loop is
identical on the bench and on the hardware.
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Protocol

log = logging.getLogger("stylus.led")


class Pattern(Enum):
    IDLE = "idle"  # slow breathe (2s)
    PLAYING = "playing"  # solid on
    ERROR = "error"  # fast blink (downstream post failed)
    START_ACK = "start_ack"  # two short blinks: "I heard you"


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


def create_led(enabled: bool):
    """Bench factory. Real GPIO/PWM driver on the Pi is step 11; off-hardware we log."""
    return LoggingLed() if enabled else NoopLed()
