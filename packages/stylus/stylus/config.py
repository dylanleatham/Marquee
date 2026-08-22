"""Config loading for Stylus (stylus-spec §9).

Reads ``config.toml`` with :mod:`tomllib` (stdlib, 3.11+). Everything has a sane default so a
minimal file — or none at all — still boots on the bench. The only thing you really must set for a
real run is at least one downstream ``url``.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .rf import one_byte


@dataclass(frozen=True)
class ReaderConfig:
    """Polling + debounce tuning (stylus-spec §7). Defaults match the spec's table."""

    id: str = "primary"
    poll_interval_ms: int = 200
    insertion_debounce_polls: int = 2
    removal_debounce_polls: int = 10
    swap_debounce_polls: int = 1
    # How long the one-time PN532 bring-up gets before Stylus gives up and exits so systemd can
    # restart it (stylus-spec §12, [ADR 0076], #307). A healthy init is well under a second, so
    # 10s is deliberately generous: too *tight* a bound turns a slow-but-working module into a
    # boot loop, which is a worse failure than the hang it's guarding. Raise it before suspecting
    # it. This is the single definition — `reader.py` reads its fallback off this field.
    init_timeout_ms: int = 10_000
    # Consecutive blind polls before the reader re-runs its own bring-up sequence (0 disables).
    # 3000 ≈ 10 minutes at the default interval.
    #
    # Deliberately far above `removal_debounce_polls`: a run this long cannot be a record playing,
    # because the machine published `stop` hundreds of polls ago. So this only fires on an idle
    # stand, where re-initialising costs nothing and interrupts nobody — which is what makes it safe
    # to run on a timer instead of on a diagnosis. "Nothing read" is the normal state of an empty
    # stand and cannot be distinguished from a wedged reader ([#322]), so the only honest move is an
    # action that is free when it was unnecessary.
    #
    # [#322]: https://github.com/dylanleatham/Marquee/issues/322
    reinit_after_blind_polls: int = 3000

    def __post_init__(self) -> None:
        # A zero/negative interval would busy-spin; a debounce < 1 would fire on the first stray
        # read; a zero init bound would fail every boot instantly. Guard here so a hand-edited
        # config can't wedge the loop into nonsense.
        for name in (
            "poll_interval_ms",
            "insertion_debounce_polls",
            "removal_debounce_polls",
            "swap_debounce_polls",
            "init_timeout_ms",
        ):
            if getattr(self, name) < 1:
                raise ValueError(f"reader.{name} must be >= 1")
        # Separate because 0 is meaningful here — it disables the re-init rather than being nonsense.
        if self.reinit_after_blind_polls < 0:
            raise ValueError("reader.reinit_after_blind_polls must be >= 0 (0 disables the re-init)")


@dataclass(frozen=True)
class Downstream:
    """A service Stylus fans scan events out to (Conductor, Backdrop, Amp)."""

    name: str
    url: str
    # 3s, not 1s. Conductor's /api/scan resolves the album and drives the Hue bridge before it
    # replies — measured at ~3s on real hardware — so a 1s default failed every scan and burned all
    # three retries doing it. This default has to clear the *slowest* downstream; Conductor's own
    # config should raise it further (see config.example.toml).
    timeout_ms: int = 3000
    shared_secret: str | None = None


@dataclass(frozen=True)
class LedConfig:
    gpio_pin: int = 17
    enabled: bool = True


@dataclass(frozen=True)
class SwitchConfig:
    """The stand's latching on/off switch (stylus-spec §7.1, [ADR 0093]).

    Disabled by default: the stand shipped without one, and an absent switch must read as "live"
    rather than as "off". ``live_when`` is which pin level you decided means on when you mounted it
    — with the documented wiring (switch to ground, internal pull-up) ``"low"`` means a *closed*
    switch is live.
    """

    enabled: bool = False
    gpio_pin: int = 27
    live_when: str = "low"

    def __post_init__(self) -> None:
        if self.live_when not in ("low", "high"):
            raise ValueError(f'switch.live_when must be "low" or "high" (got {self.live_when!r})')
        # GPIO 2/3 are the PN532's I²C bus and 17 is the LED (§4). Sharing one would half-work in a
        # way that reads as a flaky reader, so refuse it here rather than at 1am on the stand.
        if self.enabled and self.gpio_pin in _RESERVED_GPIO:
            raise ValueError(
                f"switch.gpio_pin {self.gpio_pin} is already used by "
                f"{_RESERVED_GPIO[self.gpio_pin]} — pick a free pin"
            )

    @property
    def live_when_low(self) -> bool:
        return self.live_when == "low"


# What else on this Pi already owns a pin. The LED's is configurable, so this covers its default;
# a non-default LED pin colliding is caught by `config_from_dict`, which knows both numbers.
_RESERVED_GPIO = {2: "the PN532's I²C SDA", 3: "the PN532's I²C SCL", 17: "the status LED"}


@dataclass(frozen=True)
class RfConfig:
    """PN532 transmit drive (stylus-spec §10, [ADR 0075]).

    The defaults are **not** the chip's. Measured on the real stand, the chip's power-on drive
    (``0xF4``/``0x3F``) reads 0/6 at every distance from contact to 3cm — it overcouples — while
    these read 6/6 across that whole span ([#303]). Range tuning for a different mount is a config
    edit, not a code change: lower values mean a weaker field and a shorter maximum range, which is
    the direction to move if tags fail *close in*.

    [#303]: https://github.com/dylanleatham/Marquee/issues/303
    """

    gsn_on: int = 0x84
    cw_gsp: int = 0x18
    # How often to re-assert the drive, in polls (0 disables). ~30s at the default 200ms interval.
    #
    # The drive is volatile — it lives in chip registers until something resets them — and it used
    # to be written exactly once, at bring-up. A chip that lost it fell back to the power-on
    # `0xF4`/`0x3F`, which on this stand reads 0/6 at every distance from contact to 3cm ([#303]):
    # deaf, with no error anywhere, and a restart the only known cure ([#322], twice). Re-asserting
    # it costs one register write per cadence and is idempotent, so it is cheap enough to do without
    # first proving that is what happened.
    #
    # [#303]: https://github.com/dylanleatham/Marquee/issues/303
    # [#322]: https://github.com/dylanleatham/Marquee/issues/322
    refresh_every_polls: int = 150

    def __post_init__(self) -> None:
        # These go on the wire as single bytes; an overflowing hand-edit would otherwise be
        # truncated silently into some other drive setting. `one_byte` is the wire layer's own
        # guard, borrowed rather than restated so the two can't drift apart.
        for name in ("gsn_on", "cw_gsp"):
            one_byte(name, getattr(self, name))
        if self.refresh_every_polls < 0:
            raise ValueError("rf.refresh_every_polls must be >= 0 (0 disables the refresh)")


@dataclass(frozen=True)
class Config:
    reader: ReaderConfig = field(default_factory=ReaderConfig)
    downstreams: tuple[Downstream, ...] = ()
    status_listen_port: int = 4741
    led: LedConfig = field(default_factory=LedConfig)
    rf: RfConfig = field(default_factory=RfConfig)
    switch: SwitchConfig = field(default_factory=SwitchConfig)


# The downstreams, in fan-out order: lights, then video, then audio. `player` is accepted as a
# legacy alias for `backdrop` (the service's committed name; older configs and stylus-spec §9 still
# say "player"). `amp` is the ADR 0034 third leg — a `curator:card:` scan streams over Sonos.
_DOWNSTREAM_KEYS = ("conductor", "backdrop", "player", "amp")
_KNOWN_DOWNSTREAMS = frozenset(_DOWNSTREAM_KEYS)


def _downstreams_from(section: dict[str, Any]) -> tuple[Downstream, ...]:
    # A key this function doesn't recognise used to be skipped in silence, which is how a whole
    # service can be configured and never receive anything: `[downstream.amp]` in config.toml read
    # as valid TOML, raised nothing, logged nothing, and simply never became a downstream. Refuse
    # it instead — a downstream you thought you wired up is worth a crash loop in journalctl.
    unknown = sorted(set(section) - _KNOWN_DOWNSTREAMS)
    if unknown:
        raise ValueError(
            f"unknown downstream(s): {', '.join(unknown)} (known: {', '.join(_DOWNSTREAM_KEYS)})"
        )
    out: list[Downstream] = []
    seen: set[str] = set()
    for key in _DOWNSTREAM_KEYS:
        if key not in section:
            continue
        name = "backdrop" if key == "player" else key
        if name in seen:
            continue  # explicit [downstream.backdrop] wins over a legacy [downstream.player]
        seen.add(name)
        d = section[key]
        url = d.get("url")
        if not url:
            raise ValueError(f"downstream.{key} has no url")
        out.append(
            Downstream(
                name=name,
                url=str(url),
                timeout_ms=int(d.get("timeout_ms", 3000)),
                shared_secret=d.get("shared_secret"),
            )
        )
    return tuple(out)


def config_from_dict(raw: dict[str, Any]) -> Config:
    """Build a :class:`Config` from an already-parsed TOML dict (the unit-testable core)."""
    reader_raw = raw.get("reader", {})
    reader = ReaderConfig(
        id=str(reader_raw.get("id", "primary")),
        poll_interval_ms=int(reader_raw.get("poll_interval_ms", 200)),
        insertion_debounce_polls=int(reader_raw.get("insertion_debounce_polls", 2)),
        removal_debounce_polls=int(reader_raw.get("removal_debounce_polls", 10)),
        swap_debounce_polls=int(reader_raw.get("swap_debounce_polls", 1)),
        init_timeout_ms=int(reader_raw.get("init_timeout_ms", ReaderConfig.init_timeout_ms)),
        reinit_after_blind_polls=int(
            reader_raw.get("reinit_after_blind_polls", ReaderConfig.reinit_after_blind_polls)
        ),
    )
    led_raw = raw.get("led", {})
    led = LedConfig(
        gpio_pin=int(led_raw.get("gpio_pin", 17)),
        enabled=bool(led_raw.get("enabled", True)),
    )
    rf_raw = raw.get("rf", {})
    rf = RfConfig(
        gsn_on=int(rf_raw.get("gsn_on", RfConfig.gsn_on)),
        cw_gsp=int(rf_raw.get("cw_gsp", RfConfig.cw_gsp)),
        refresh_every_polls=int(
            rf_raw.get("refresh_every_polls", RfConfig.refresh_every_polls)
        ),
    )
    switch_raw = raw.get("switch", {})
    switch = SwitchConfig(
        enabled=bool(switch_raw.get("enabled", False)),
        gpio_pin=int(switch_raw.get("gpio_pin", SwitchConfig.gpio_pin)),
        live_when=str(switch_raw.get("live_when", SwitchConfig.live_when)),
    )
    # `SwitchConfig` can only guard the LED's *default* pin; here both numbers are in hand.
    if switch.enabled and switch.gpio_pin == led.gpio_pin:
        raise ValueError(f"switch.gpio_pin {switch.gpio_pin} is already led.gpio_pin")
    status_raw = raw.get("status", {})
    return Config(
        reader=reader,
        downstreams=_downstreams_from(raw.get("downstream", {})),
        status_listen_port=int(status_raw.get("listen_port", 4741)),
        led=led,
        rf=rf,
        switch=switch,
    )


def load_config(path: str | Path) -> Config:
    """Load and parse ``config.toml`` from disk."""
    with open(path, "rb") as f:
        return config_from_dict(tomllib.load(f))
