"""Tag readers (stylus-spec §6, §7, §11).

The state machine consumes one :class:`TagRead` (uid + decoded URI) per poll. Two implementations:

* :class:`SimulatedReader` — the bench reader. The current tag is set programmatically, by tests and
  by the ``POST /simulate`` status endpoint (§8). This is what makes the whole service testable and
  demoable with no PN532 attached.
* :func:`create_pn532_reader` — the real one, on the Pi. It imports ``adafruit_pn532`` lazily so the
  package still imports (and CI still runs) on a machine without the hardware libraries. Building the
  live read loop + mounting is milestone 6/step 11; the NDEF *assembly* below is pure and tested now.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Protocol

from .bounded import run_or_die
from .config import ReaderConfig, RfConfig
from .ndef import parse_uri
from .rf import configure_tx_drive
from .state_machine import TagRead


class TagReader(Protocol):
    def poll(self) -> TagRead | None:
        """Return the tag currently in the field (uid + decoded URI), or ``None`` if none."""
        ...


class SimulatedReader:
    """Bench reader: ``set_tag``/``clear`` drive what ``poll`` reports (used by tests and /simulate)."""

    def __init__(self) -> None:
        self._current: TagRead | None = None

    def set_tag(self, uid: str, uri: str | None) -> None:
        self._current = TagRead(uid=uid, uri=uri)

    def clear(self) -> None:
        self._current = None

    def poll(self) -> TagRead | None:
        return self._current


def _ndef_tlv_end(data: bytes) -> int | None:
    """Byte offset just past the NDEF-message TLV's value, or ``None`` if ``data`` doesn't reach it.

    Walks the same TLV chain :func:`stylus.ndef._unwrap_tlv` walks, but over a *partial* read, so it
    answers the only question the page loop has: am I done, or do I still owe bytes? ``None`` means
    "keep reading" — including for a bare NDEF message with no TLV wrapper (MB bit set), whose
    length can't be known from the front, where reading everything is the safe answer.
    """
    if data and data[0] & 0x80:
        return None
    i, n = 0, len(data)
    while i < n:
        t = data[i]
        if t == 0x00:  # NULL TLV — padding, skip
            i += 1
            continue
        if t == 0xFE:  # Terminator TLV — there is no NDEF message on this tag
            return i + 1
        if i + 1 >= n:
            return None  # length byte not read yet
        length = data[i + 1]
        i += 2
        if length == 0xFF:  # 3-byte length form
            if i + 1 >= n:
                return None
            length = (data[i] << 8) | data[i + 1]
            i += 2
        if t == 0x03:  # NDEF Message TLV — done once its whole value is in hand
            return i + length
        i += length  # some other TLV (lock control 0x01, etc.) — skip its value
    return None


def _read_page(read_page: Callable[[int], bytes | None], page: int, attempts: int) -> bytes | None:
    """One page, retried. A single dropped I²C read mid-record is the whole bug this file guards."""
    for _ in range(attempts):
        data = read_page(page)
        if data:
            return data
    return None


# NTAG213 user memory is read 4 bytes (one page) at a time. Assemble pages into the NDEF-message
# byte string, stopping once the NDEF-message TLV is *complete* or when a page read fails. Pure so
# it's testable with a fake page reader; the real reader passes the PN532's ``ntag2xx_read_block``.
#
# Stopping used to mean "this page contained an 0xFE byte", which is not the same question: it stops
# early on a payload byte that happens to be 0xFE, and — the failure that motivated this — it can't
# tell a finished message from a read that died halfway through one. Reading to the length the tag
# itself declares means a short read is short by a knowable amount, and `parse_uri` rejects it
# instead of decoding the prefix into a plausible shorter URI.
def assemble_ntag_ndef(
    read_page: Callable[[int], bytes | None],
    start_page: int = 4,
    max_pages: int = 40,
    page_attempts: int = 3,
) -> bytes:
    out = bytearray()
    for page in range(start_page, start_page + max_pages):
        data = _read_page(read_page, page, page_attempts)
        if not data:
            break
        out.extend(data)
        end = _ndef_tlv_end(bytes(out))
        if end is not None and len(out) >= end:
            break
    return bytes(out)


class UriCache:
    """Per-UID cache of decoded URIs: the slow NDEF read happens once per sleeve, not every poll.

    **Only successful decodes are cached.** A tag's UID does not change when you write NDEF to it, so
    caching a miss means a tag that was blank the first time we saw it stays blank to us forever —
    you write the sleeve, hold it to the reader, and nothing happens until the service restarts.
    That cost a real debugging session during the step-11 bring-up: the UID was in the log every
    poll, so the reader looked perfect while serving a `None` decided minutes earlier.

    Re-reading NDEF on every poll of an genuinely unwritten tag is the deliberate trade: it's a
    handful of I²C page reads against a tag nobody is waiting on, versus a working sleeve that
    silently never fires.

    **Hits are scoped to one placement**, cleared by :meth:`forget_all` once the field is *confirmed*
    empty (see :func:`decode_poll`). That UID-stability cuts the other way too: *rewriting* a sticker
    doesn't change its UID either, so a hit that outlives the placement outlives the album it decoded
    — the Flipper shows the new record, the cache keeps serving the old one, and nothing short of a
    service restart dislodges it. Lifting the sleeve is the operator saying "this may be a different
    record now", which makes it the natural invalidation point and costs exactly one NDEF read per
    placement — the saving the cache was for in the first place.

    **A placement ends at ``forget_after_absent_polls``, not at one missed poll**
    ([#337](https://github.com/dylanleatham/Marquee/issues/337)). Those are very different questions
    on real hardware: a marginally-coupled tag drops the occasional read while sitting perfectly
    still, and invalidating on the first of those forced a full NDEF re-read — up to 40 pages x 3
    attempts — on the very next sighting, precisely when the tag was already struggling. The cost
    was a card that replayed from track 1 every ~20s. The reader already has an answer for "is it
    really gone": ``removal_debounce_polls``, which is what the state machine publishes ``stop`` on,
    so the cache defaults to the same threshold and the two agree by construction. A dropout short
    enough that the room never noticed must not cost a re-read either.
    """

    def __init__(
        self,
        max_size: int = 8,
        forget_after_absent_polls: int = ReaderConfig.removal_debounce_polls,
    ) -> None:
        self._max_size = max_size
        # Clamped rather than validated: a nonsensical value should degrade to the old
        # invalidate-immediately behaviour, never to a cache nothing can dislodge.
        self._forget_after = max(1, forget_after_absent_polls)
        self._hits: dict[str, str] = {}
        # Consecutive polls that saw an empty field — the cache's half of the removal debounce.
        self._absent = 0

    def get_or_read(self, uid: str, read_ndef: Callable[[], bytes]) -> str | None:
        """Return the cached URI for ``uid``, else decode one via ``read_ndef`` (cached if found)."""
        cached = self._hits.get(uid)
        if cached is not None:
            return cached
        uri = parse_uri(read_ndef())
        if uri is not None:
            if len(self._hits) >= self._max_size:
                self._hits.clear()
            self._hits[uid] = uri
        return uri

    def forget_all(self) -> None:
        """Drop every cached decode — the next sight of any UID re-reads the tag."""
        self._hits.clear()

    def note_present(self) -> None:
        """A poll that saw a tag: the placement is ongoing, so any absent streak is over."""
        self._absent = 0

    def note_absent(self) -> int:
        """A poll that saw an empty field. Forgets every decode once the streak confirms a removal.

        Returns the streak length, so the caller can say how blind it has been rather than leaving
        a dropout to be inferred from its downstream effects (#337).
        """
        self._absent += 1
        if self._absent >= self._forget_after:
            self.forget_all()
        return self._absent


def decode_poll(
    cache: UriCache, uid: str | None, read_ndef: Callable[[], bytes]
) -> TagRead | None:
    """One poll's decode: ``uid`` is what the PN532 saw (``None`` = empty field).

    Pure but for the two callables, so the caching *policy* is testable without a PN532 — the
    hardware factory below is left as nothing but wiring. A *confirmed* empty field invalidates the
    cache, so a sticker rewritten between placements is decoded afresh rather than served from the
    last read.

    "Confirmed" is the whole of #337: a dropped read on a sleeve that never moved also lands here,
    and treating that as a removal made the next sighting pay for a full NDEF re-read on a tag that
    was already reading badly. See :class:`UriCache` for why the threshold is the removal debounce.
    """
    if uid is None:
        cache.note_absent()
        return None
    cache.note_present()
    return TagRead(uid=uid, uri=cache.get_or_read(uid, read_ndef))


def build_pn532_reader(
    pn532,
    rf: RfConfig,
    uid_cache_size: int = 8,
    *,
    forget_after_absent_polls: int = ReaderConfig.removal_debounce_polls,
) -> TagReader:
    """Configure an already-constructed PN532 and wrap it as a :class:`TagReader`.

    Split out of :func:`create_pn532_reader` so the *setup sequence* is testable with a fake chip.
    That split is the durable half of [#303]: the reader inherited the chip's power-on transmit
    drive, which overcouples badly enough that a tag on the antenna is never seen at all, and no
    test could reach the factory to notice the configuration step was missing. Applying the drive
    before the first poll is now an assertion, not a convention.

    [#303]: https://github.com/dylanleatham/Marquee/issues/303
    """
    pn532.SAM_configuration()
    configure_tx_drive(pn532.call_function, rf.gsn_on, rf.cw_gsp)

    cache = UriCache(uid_cache_size, forget_after_absent_polls)

    class _Pn532Reader:
        def poll(self) -> TagRead | None:
            raw = pn532.read_passive_target(timeout=0.05)
            uid = None if raw is None else ":".join(f"{b:02X}" for b in raw)
            return decode_poll(
                cache, uid, lambda: assemble_ntag_ndef(lambda p: pn532.ntag2xx_read_block(p))
            )

    return _Pn532Reader()


def open_pn532_reader(
    connect: Callable[[], object],
    rf: RfConfig,
    uid_cache_size: int = 8,
    *,
    init_timeout_s: float = ReaderConfig.init_timeout_ms / 1000,
    forget_after_absent_polls: int = ReaderConfig.removal_debounce_polls,
    exit_: Callable[[int], None] = os._exit,
) -> TagReader:
    """Bring up a PN532 under a time bound: ``connect()`` builds the chip, then it's configured.

    ``connect`` is injected so the bound covers *construction* too. That is the point of this
    function existing rather than the bound living inside :func:`build_pn532_reader`: two of the
    four calls that can wedge — ``busio.I2C`` and ``PN532_I2C`` — happen before there is a chip
    object to configure, and they are the two DEPLOY.md §12 names. Bounding only the setup sequence
    would look like protection while leaving the documented hang sites open
    ([#307](https://github.com/dylanleatham/Marquee/issues/307)).

    A hang exits the process; the unit's ``Restart=always`` brings it back against a module that
    gets a fresh chance to answer. See :mod:`stylus.bounded` for why it can't be recovered in-place.
    """
    return run_or_die(
        lambda: build_pn532_reader(
            connect(), rf, uid_cache_size, forget_after_absent_polls=forget_after_absent_polls
        ),
        init_timeout_s,
        stage="PN532 init",
        exit_=exit_,
    )


def create_pn532_reader(  # pragma: no cover - hardware imports only; see open_pn532_reader
    rf: RfConfig | None = None,
    uid_cache_size: int = 8,
    init_timeout_ms: int = ReaderConfig.init_timeout_ms,
    forget_after_absent_polls: int = ReaderConfig.removal_debounce_polls,
) -> TagReader:
    """Build the real PN532 reader. Raises a clear error off-Pi (no ``adafruit_pn532``).

    Nothing but imports lives here — decoding and caching are in :class:`UriCache` /
    :func:`assemble_ntag_ndef`, the setup sequence is in :func:`build_pn532_reader`, and the
    construction is a closure handed to :func:`open_pn532_reader` so the time bound covers it. All
    of them pure or injectable and tested.
    """
    try:
        import board  # type: ignore
        import busio  # type: ignore
        from adafruit_pn532.i2c import PN532_I2C  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "PN532 libraries not available — this reader only runs on the Pi. "
            "Use SimulatedReader on the bench."
        ) from e

    def connect():
        # Inside the bound, not before it: opening the bus is the first thing that can wedge.
        return PN532_I2C(busio.I2C(board.SCL, board.SDA), debug=False)

    return open_pn532_reader(
        connect,
        rf or RfConfig(),
        uid_cache_size,
        init_timeout_s=init_timeout_ms / 1000,
        forget_after_absent_polls=forget_after_absent_polls,
    )
