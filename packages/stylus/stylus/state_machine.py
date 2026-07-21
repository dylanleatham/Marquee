"""The detection state machine (stylus-spec §7).

Pure and I/O-free: you feed it one observation per poll — a :class:`TagRead` (uid + the URI read
off that tag) or ``None`` (no tag in field) — and it returns the :class:`Action` the app should
carry out (publish start/stop, or flag a bad tag), or ``None`` for "no change". All timing and all
network calls live in the app loop; keeping this pure makes the debounce/swap logic trivial to test
with plain cases and Hypothesis property tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .config import ReaderConfig
from .events import is_album_uri


class State(Enum):
    IDLE = "idle"
    PLAYING = "playing"


@dataclass(frozen=True)
class TagRead:
    """One poll's reading: the tag's UID and the URI decoded from its NDEF (``None`` if unreadable)."""

    uid: str
    uri: str | None


@dataclass(frozen=True)
class Start:
    """Insertion debounce met from IDLE with a valid tag → publish ``start``."""

    uid: str
    uri: str


@dataclass(frozen=True)
class Swap:
    """A different valid tag appeared while PLAYING → publish ``stop`` then ``start`` (§7 SWAP)."""

    uid: str
    uri: str


@dataclass(frozen=True)
class Stop:
    """Removal debounce met → publish ``stop`` and return to IDLE."""


@dataclass(frozen=True)
class BadTag:
    """A stable tag whose URI didn't parse to a ``curator:album`` URI — flag it (LED/log), don't fire."""

    uid: str


Action = Start | Swap | Stop | BadTag


class DetectionMachine:
    def __init__(self, cfg: ReaderConfig) -> None:
        self._cfg = cfg
        self.state = State.IDLE
        self.current_uid: str | None = None
        self.current_uri: str | None = None
        # Consecutive polls seeing `_cand_uid` (drives insertion in IDLE, swap in PLAYING).
        self._cand_uid: str | None = None
        self._cand_count = 0
        # Consecutive polls with no tag (drives removal in PLAYING).
        self._absent = 0
        # A bad UID we've already flagged, so a sleeve left on the reader doesn't re-flag every poll.
        self._flagged_bad: str | None = None

    def observe(self, tag: TagRead | None) -> Action | None:
        if self.state is State.IDLE:
            return self._observe_idle(tag)
        return self._observe_playing(tag)

    # --- IDLE -------------------------------------------------------------------------------------
    def _observe_idle(self, tag: TagRead | None) -> Action | None:
        if tag is None:
            self._reset_candidate()
            return None
        self._bump_candidate(tag.uid)
        # Fire exactly when the streak first reaches the threshold; further polls of the same tag
        # (count > threshold) neither re-fire nor re-flag.
        if self._cand_count != self._cfg.insertion_debounce_polls:
            return None
        if tag.uri is not None and is_album_uri(tag.uri):
            self._enter_playing(tag.uid, tag.uri)
            return Start(uid=tag.uid, uri=tag.uri)
        if self._flagged_bad != tag.uid:
            self._flagged_bad = tag.uid
            return BadTag(uid=tag.uid)
        return None

    # --- PLAYING ----------------------------------------------------------------------------------
    def _observe_playing(self, tag: TagRead | None) -> Action | None:
        if tag is None:
            self._reset_candidate()
            self._absent += 1
            if self._absent >= self._cfg.removal_debounce_polls:
                self._enter_idle()
                return Stop()
            return None

        # Any presence cancels an in-progress removal countdown.
        self._absent = 0
        if tag.uid == self.current_uid:
            self._reset_candidate()  # same sleeve still there — no swap in progress
            return None

        # A different tag: count toward a swap.
        self._bump_candidate(tag.uid)
        if self._cand_count < self._cfg.swap_debounce_polls:
            return None
        if tag.uri is not None and is_album_uri(tag.uri):
            self._reset_candidate()
            self.current_uid = tag.uid
            self.current_uri = tag.uri
            return Swap(uid=tag.uid, uri=tag.uri)
        # Different but unreadable tag — ignore it and keep playing the current album.
        return None

    # --- helpers ----------------------------------------------------------------------------------
    def _bump_candidate(self, uid: str) -> None:
        if uid == self._cand_uid:
            self._cand_count += 1
        else:
            self._cand_uid = uid
            self._cand_count = 1
            self._flagged_bad = None

    def _reset_candidate(self) -> None:
        self._cand_uid = None
        self._cand_count = 0

    def _enter_playing(self, uid: str, uri: str) -> None:
        self.state = State.PLAYING
        self.current_uid = uid
        self.current_uri = uri
        self._reset_candidate()
        self._absent = 0

    def _enter_idle(self) -> None:
        self.state = State.IDLE
        self.current_uid = None
        self.current_uri = None
        self._reset_candidate()
        self._absent = 0
        self._flagged_bad = None
