"""The stand's on/off switch (stylus-spec §7.1, [ADR 0093]).

A **latching** switch wired to a GPIO pin: its physical position *is* the state. That is the whole
reason this module has no persistence and no toggle bookkeeping — the pin is readable at boot, so a
stand that was off stays off across a reboot, a `systemd` restart, or the §12 watchdog killing a
wedged poll loop. A momentary button would have needed a state file to make the same promise, and a
state file that disagrees with the thing on the front of the stand is worse than no switch.

Three implementations behind one seam, mirroring :mod:`stylus.led`:

* :class:`AlwaysLive` — no switch on this host, or its hardware isn't there. Always live.
* :class:`SimulatedSwitch` — the bench: driven over ``POST /switch``, so the off-state can be
  exercised end-to-end with no GPIO.
* :class:`GpioSwitch` — the Pi: reads the pin once per poll through an injectable
  :class:`SwitchDriver`.

**Failure direction is deliberate: unreadable ⇒ live.** A stand that silently refuses to react is
indistinguishable from a broken one, so a switch we cannot read holds its last known position and,
failing that, gets out of the way. The condition is never silent — it logs, and ``source`` on
``GET /status`` names it.
"""

from __future__ import annotations

import logging
from typing import Protocol

log = logging.getLogger("stylus.switch")


class Switch(Protocol):
    def is_live(self) -> bool:
        ...

    @property
    def source(self) -> str:
        """Where this reading comes from — reported on ``GET /status`` so a switch that isn't
        actually wired up can't masquerade as one that is."""
        ...


class AlwaysLive:
    """No switch here. ``source`` distinguishes "none configured" from "configured but broken"."""

    def __init__(self, source: str = "none") -> None:
        self._source = source

    @property
    def source(self) -> str:
        return self._source

    def is_live(self) -> bool:
        return True


class SimulatedSwitch:
    """Bench switch, flipped over ``POST /switch`` — the off-state's counterpart to ``/simulate``."""

    def __init__(self, live: bool = True) -> None:
        self._live = live

    @property
    def source(self) -> str:
        return "simulated"

    def is_live(self) -> bool:
        return self._live

    def set_live(self, live: bool) -> None:
        self._live = live


class SwitchDriver(Protocol):
    """The only part that touches hardware: read the pin, as a plain "is the stand live" boolean."""

    def read(self) -> bool:
        ...

    def close(self) -> None:
        ...


class GpioSwitch:
    """Reads the pin every poll. No debounce, deliberately: a mechanical switch settles in under a
    millisecond or two, and the poll interval is 200ms (§7), so no two consecutive polls can land
    inside one bounce. The insertion/removal debounces downstream absorb the rest."""

    def __init__(self, driver: SwitchDriver) -> None:
        self._driver = driver
        # Live until the pin says otherwise: a first read that throws must not silence the stand.
        self._last = True
        self._failing = False

    @property
    def source(self) -> str:
        return "gpio"

    def is_live(self) -> bool:
        try:
            self._last = self._driver.read()
        except Exception as e:  # noqa: BLE001 — a switch fault must never kill the poll loop
            if not self._failing:
                log.warning(
                    "stand switch unreadable (%s) — holding last position: %s",
                    e,
                    "live" if self._last else "off",
                )
                self._failing = True
            return self._last
        if self._failing:
            log.info("stand switch readable again — position: %s", "live" if self._last else "off")
            self._failing = False
        return self._last

    def close(self) -> None:
        self._driver.close()


def create_gpio_driver(gpio_pin: int, *, live_when_low: bool) -> SwitchDriver:  # pragma: no cover - hardware path
    """Build the real GPIO driver via Blinka. Raises a clear error off-Pi.

    The internal pull-up is always enabled, because the documented wiring is the simple one: switch
    between the pin and ground, no external resistor. Closed pulls the pin low; open floats high.
    ``live_when_low`` is which of those two you decided means "on" when you mounted the switch.
    """
    try:
        import board  # type: ignore
        import digitalio  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            f"GPIO libraries not available — the switch only runs on the Pi. Install the hardware "
            f"extra (pip install '.[hardware]') or set [switch].enabled = false. ({e})"
        ) from e

    pin = getattr(board, f"D{gpio_pin}")
    inp = digitalio.DigitalInOut(pin)
    inp.direction = digitalio.Direction.INPUT
    inp.pull = digitalio.Pull.UP

    class _GpioSwitchDriver:
        def read(self) -> bool:
            return (not inp.value) if live_when_low else bool(inp.value)

        def close(self) -> None:
            inp.deinit()

    log.info(
        "stand switch on GPIO %d (live when %s)", gpio_pin, "low" if live_when_low else "high"
    )
    return _GpioSwitchDriver()


def create_switch(enabled: bool, gpio_pin: int, *, live_when_low: bool) -> Switch:
    """Build the switch for this host.

    Falls back to :class:`AlwaysLive` when the hardware isn't there — same shape as
    :func:`stylus.led.create_led`, and for the same reason: the reader is the product. Unlike the
    LED this logs at ERROR, because a switch that silently does nothing is a control you will stand
    there flipping. ``source`` on ``GET /status`` reads ``unavailable`` for exactly this case.
    """
    if not enabled:
        return AlwaysLive()
    try:
        return GpioSwitch(create_gpio_driver(gpio_pin, live_when_low=live_when_low))
    except Exception as e:  # noqa: BLE001 — no switch is bad; no stand is worse
        log.error("stand switch unavailable, the stand will stay live: %s", e)
        return AlwaysLive(source="unavailable")
