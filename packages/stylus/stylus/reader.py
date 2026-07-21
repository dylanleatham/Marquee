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


# NTAG213 user memory is read 4 bytes (one page) at a time. Assemble pages into the NDEF-message
# byte string, stopping at the terminator TLV (0xFE) or when a page read fails. Pure so it's testable
# with a fake page reader; the real reader passes the PN532's ``ntag2xx_read_block``.
def assemble_ntag_ndef(
    read_page: Callable[[int], bytes | None],
    start_page: int = 4,
    max_pages: int = 40,
) -> bytes:
    out = bytearray()
    for page in range(start_page, start_page + max_pages):
        data = read_page(page)
        if not data:
            break
        out.extend(data)
        if 0xFE in data:  # terminator TLV — no need to read further
            break
    return bytes(out)


def create_pn532_reader(uid_cache_size: int = 8):  # pragma: no cover - hardware path (step 11)
    """Build the real PN532 reader. Raises a clear error off-Pi (no ``adafruit_pn532``).

    Caches the decoded URI per UID so the slow NDEF read happens once per new sleeve, not every poll
    (§7: "tag UID detected → read NDEF"). Wiring/mount/range tuning is step 11.
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

    cache: dict[str, str | None] = {}

    class _Pn532Reader:
        def poll(self) -> TagRead | None:
            raw = pn532.read_passive_target(timeout=0.05)
            if raw is None:
                return None
            uid = ":".join(f"{b:02X}" for b in raw)
            if uid not in cache:
                if len(cache) >= uid_cache_size:
                    cache.clear()
                ndef = assemble_ntag_ndef(lambda p: pn532.ntag2xx_read_block(p))
                cache[uid] = parse_uri(ndef)
            return TagRead(uid=uid, uri=cache[uid])

    return _Pn532Reader()
