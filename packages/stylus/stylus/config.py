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

    def __post_init__(self) -> None:
        # A zero/negative interval would busy-spin; a debounce < 1 would fire on the first stray
        # read. Guard here so a hand-edited config can't wedge the loop into nonsense.
        for name in (
            "poll_interval_ms",
            "insertion_debounce_polls",
            "removal_debounce_polls",
            "swap_debounce_polls",
        ):
            if getattr(self, name) < 1:
                raise ValueError(f"reader.{name} must be >= 1")


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

    def __post_init__(self) -> None:
        # These go on the wire as single bytes; an overflowing hand-edit would otherwise be
        # truncated silently into some other drive setting. `one_byte` is the wire layer's own
        # guard, borrowed rather than restated so the two can't drift apart.
        for name in ("gsn_on", "cw_gsp"):
            one_byte(name, getattr(self, name))


@dataclass(frozen=True)
class Config:
    reader: ReaderConfig = field(default_factory=ReaderConfig)
    downstreams: tuple[Downstream, ...] = ()
    status_listen_port: int = 4741
    led: LedConfig = field(default_factory=LedConfig)
    rf: RfConfig = field(default_factory=RfConfig)


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
    )
    status_raw = raw.get("status", {})
    return Config(
        reader=reader,
        downstreams=_downstreams_from(raw.get("downstream", {})),
        status_listen_port=int(status_raw.get("listen_port", 4741)),
        led=led,
        rf=rf,
    )


def load_config(path: str | Path) -> Config:
    """Load and parse ``config.toml`` from disk."""
    with open(path, "rb") as f:
        return config_from_dict(tomllib.load(f))
