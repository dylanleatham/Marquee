import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from stylus.events import is_album_uri, now_iso, start_event, stop_event

_SCHEMA = json.loads(
    (
        Path(__file__).resolve().parents[2] / "contracts" / "schemas" / "scan-event.schema.json"
    ).read_text()
)
_VALIDATOR = Draft202012Validator(_SCHEMA)

URI = "curator:album:2k7bxq9m"
UID = "04:A1:B2:C3:D4:E5:F6"


def test_start_event_matches_the_shared_contract():
    ev = start_event(URI, UID, "primary", at="2026-07-06T20:15:22Z")
    _VALIDATOR.validate(ev)  # raises on drift from scan-event.schema.json
    assert ev == {
        "event": "start",
        "uri": URI,
        "tagUid": UID,
        "readerId": "primary",
        "at": "2026-07-06T20:15:22Z",
    }


def test_stop_event_matches_the_shared_contract():
    ev = stop_event("primary", at="2026-07-06T20:47:03Z")
    _VALIDATOR.validate(ev)
    assert "uri" not in ev and "tagUid" not in ev


def test_start_requires_uri_and_taguid_per_schema():
    # Sanity that the schema really enforces the start-only fields (guards our test, not our code).
    bad = {"event": "start", "readerId": "primary", "at": "2026-07-06T20:15:22Z"}
    assert not _VALIDATOR.is_valid(bad)


def test_now_iso_is_zulu_seconds_precision():
    ts = now_iso()
    assert ts.endswith("Z") and "." not in ts
    assert _VALIDATOR.is_valid(start_event(URI, UID, "primary", at=ts))


@pytest.mark.parametrize(
    "uri,ok",
    [
        ("curator:album:2k7bxq9m", True),
        ("curator:album:ABC12345", False),  # uppercase not allowed by the pattern
        ("curator:album:short", False),
        ("spotify:album:2k7bxq9m", False),
        ("curator:album:2k7bxq9m ", False),
    ],
)
def test_is_album_uri(uri, ok):
    assert is_album_uri(uri) is ok
