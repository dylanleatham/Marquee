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

from collections.abc import Callable
from typing import Protocol

from .ndef import parse_uri
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
    """

    def __init__(self, max_size: int = 8) -> None:
        self._max_size = max_size
        self._hits: dict[str, str] = {}

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


def create_pn532_reader(uid_cache_size: int = 8):  # pragma: no cover - hardware path (step 11)
    """Build the real PN532 reader. Raises a clear error off-Pi (no ``adafruit_pn532``).

    Decoding and caching live in :class:`UriCache` and :func:`assemble_ntag_ndef`, both pure and
    tested — this factory is only the hardware wiring. Mount/range tuning is step 11.
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

    i2c = busio.I2C(board.SCL, board.SDA)
    pn532 = PN532_I2C(i2c, debug=False)
    pn532.SAM_configuration()

    cache = UriCache(uid_cache_size)

    class _Pn532Reader:
        def poll(self) -> TagRead | None:
            raw = pn532.read_passive_target(timeout=0.05)
            if raw is None:
                return None
            uid = ":".join(f"{b:02X}" for b in raw)
            uri = cache.get_or_read(
                uid, lambda: assemble_ntag_ndef(lambda p: pn532.ntag2xx_read_block(p))
            )
            return TagRead(uid=uid, uri=uri)

    return _Pn532Reader()
