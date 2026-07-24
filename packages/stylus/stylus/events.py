"""Scan-event payload builders (stylus-spec §8, contracts/scan-event.schema.json).

One event shape drives the whole runtime. ``start`` carries the album URI + tag UID; ``stop`` is a
bare "return to idle". Timestamps are RFC-3339 / ISO-8601 UTC with a ``Z`` suffix, matching the
schema's ``date-time`` format.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

# The URI written to a tag and keyed on downstream (scan-event.schema.json). `kind` is `album` for a
# record sleeve or `card` for a streaming-only card (ADR 0023); Stylus forwards either unchanged —
# Conductor/Backdrop treat them the same, and Amp acts on the difference.
URI_RE = re.compile(r"^curator:(album|card):[a-z0-9]{8}$")


def is_curator_uri(uri: str) -> bool:
    """True if ``uri`` is a well-formed ``curator:(album|card):<id>`` scan URI."""
    return bool(URI_RE.match(uri))


def now_iso() -> str:
    """Current UTC time as ``2026-07-06T20:15:22Z`` (seconds precision, no microseconds)."""
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def start_event(uri: str, tag_uid: str, reader_id: str, at: str | None = None) -> dict[str, Any]:
    """Build a ``start`` event. ``at`` defaults to now; injectable so tests are deterministic."""
    return {
        "event": "start",
        "uri": uri,
        "tagUid": tag_uid,
        "readerId": reader_id,
        "at": at or now_iso(),
    }


def stop_event(reader_id: str, at: str | None = None) -> dict[str, Any]:
    """Build a ``stop`` event — no ``uri``/``tagUid`` (downstream returns to idle regardless)."""
    return {
        "event": "stop",
        "readerId": reader_id,
        "at": at or now_iso(),
    }
