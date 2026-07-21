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
    """A service Stylus fans scan events out to (Conductor, Backdrop)."""

    name: str
    url: str
    timeout_ms: int = 1000
    shared_secret: str | None = None


@dataclass(frozen=True)
class LedConfig:
    gpio_pin: int = 17
    enabled: bool = True


@dataclass(frozen=True)
class Config:
    reader: ReaderConfig = field(default_factory=ReaderConfig)
    downstreams: tuple[Downstream, ...] = ()
    status_listen_port: int = 4741
    led: LedConfig = field(default_factory=LedConfig)


# The two downstreams, in fan-out order. `player` is accepted as a legacy alias for `backdrop`
# (the service's committed name; older configs and stylus-spec §9 still say "player").
_DOWNSTREAM_KEYS = ("conductor", "backdrop", "player")


def _downstreams_from(section: dict[str, Any]) -> tuple[Downstream, ...]:
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
                timeout_ms=int(d.get("timeout_ms", 1000)),
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
    status_raw = raw.get("status", {})
    return Config(
        reader=reader,
        downstreams=_downstreams_from(raw.get("downstream", {})),
        status_listen_port=int(status_raw.get("listen_port", 4741)),
        led=led,
    )


def load_config(path: str | Path) -> Config:
    """Load and parse ``config.toml`` from disk."""
    with open(path, "rb") as f:
        return config_from_dict(tomllib.load(f))
