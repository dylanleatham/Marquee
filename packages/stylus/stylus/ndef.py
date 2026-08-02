"""Minimal NDEF parsing — just enough to pull a URI off an NTAG213 (stylus-spec §6).

The spec suggests ``ndeflib``, but the tag only ever carries a single ``curator:album:<id>`` URI
(everything else is explicitly out of scope, §3), and CI runs without the Pi's dependencies. So we
hand-roll the tiny slice of the NDEF spec we need — well-known URI (and, as a courtesy, Text)
records — with the stdlib. ~1 record, ~40 lines, fully unit-testable off-hardware.

Accepts either a bare NDEF message or raw tag memory wrapped in the NDEF-message TLV (``0x03 len …
0xFE``) that ``ntag2xx`` reads hand back, so it works against real dumps and crafted test bytes.
"""

from __future__ import annotations

# NFC Forum URI Record Type Definition, abbreviation table (payload[0] indexes this).
_URI_PREFIXES = (
    "",
    "http://www.",
    "https://www.",
    "http://",
    "https://",
    "tel:",
    "mailto:",
    "ftp://anonymous:anonymous@",
    "ftp://ftp.",
    "ftps://",
    "sftp://",
    "smb://",
    "nfs://",
    "ftp://",
    "dav://",
    "news:",
    "telnet://",
    "imap:",
    "rtsp://",
    "urn:",
    "pop:",
    "sip:",
    "sips:",
    "tftp:",
    "btspp://",
    "btl2cap://",
    "btgoep://",
    "tcpobex://",
    "irdaobex://",
    "file://",
    "urn:epc:id:",
    "urn:epc:tag:",
    "urn:epc:pat:",
    "urn:epc:raw:",
    "urn:epc:",
    "urn:nfc:",
)

_TNF_WELL_KNOWN = 0x01


def _unwrap_tlv(data: bytes) -> bytes:
    """If ``data`` is raw tag memory, return the bytes inside the NDEF-message TLV (type ``0x03``).

    A bare NDEF message (first byte has the MB record-header bit, ``0x80``) is returned unchanged.
    """
    if not data:
        return data
    # A record header always has MB (0x80) set on the first record; TLV type bytes (0x00/0x01/0x03…)
    # never do. Use that to tell "already an NDEF message" from "raw tag memory with TLVs".
    if data[0] & 0x80:
        return data
    i = 0
    n = len(data)
    while i < n:
        t = data[i]
        if t == 0x00:  # NULL TLV — padding, skip
            i += 1
            continue
        if t == 0xFE:  # Terminator TLV
            break
        if i + 1 >= n:
            break
        length = data[i + 1]
        i += 2
        if length == 0xFF:  # 3-byte length form
            if i + 1 >= n:
                break
            length = (data[i] << 8) | data[i + 1]
            i += 2
        if t == 0x03:  # NDEF Message TLV
            if i + length > n:
                # The TLV declares more message than we were handed: the read stopped early. Hand
                # back nothing rather than a partial message — see ``parse_uri`` for why.
                return b""
            return data[i : i + length]
        i += length  # some other TLV (lock control 0x01, etc.) — skip its value
    return b""


def parse_uri(data: bytes) -> str | None:
    """Extract the URI string from the first well-known URI (or Text) record, or ``None``.

    Never raises on malformed input — a garbled read returns ``None`` so the caller just treats it
    as "no tag" rather than crashing the poll loop.

    A record whose declared lengths run past the end of ``data`` is treated as malformed, **not**
    decoded as far as the bytes go. Python slicing truncates silently, so the do-nothing version of
    this reads a 16-byte read of ``curator:card:frn453tp`` back as ``curator:c`` — a shorter URI
    that is perfectly well-formed, gets cached as a successful decode, and is then reported forever
    as a real tag carrying a URI nobody ever wrote. A partial read must look like a failed read.
    """
    try:
        msg = _unwrap_tlv(bytes(data))
        i = 0
        n = len(msg)
        while i < n:
            header = msg[i]
            i += 1
            tnf = header & 0x07
            short = bool(header & 0x10)  # SR
            il = bool(header & 0x08)  # ID length present
            if i >= n:
                return None
            type_len = msg[i]
            i += 1
            if short:
                payload_len = msg[i]
                i += 1
            else:
                if i + 4 > n:
                    return None
                payload_len = int.from_bytes(msg[i : i + 4], "big")
                i += 4
            id_len = 0
            if il:
                id_len = msg[i]
                i += 1
            if i + type_len + id_len + payload_len > n:
                return None  # record runs past the bytes we have — a short read, not a short URI
            rec_type = msg[i : i + type_len]
            i += type_len + id_len
            payload = msg[i : i + payload_len]
            i += payload_len

            if tnf == _TNF_WELL_KNOWN and rec_type == b"U" and payload:
                code = payload[0]
                prefix = _URI_PREFIXES[code] if code < len(_URI_PREFIXES) else ""
                return prefix + payload[1:].decode("utf-8", "replace")
            if tnf == _TNF_WELL_KNOWN and rec_type == b"T" and payload:
                # Text record: first byte is a status byte; low 6 bits = language-code length.
                lang_len = payload[0] & 0x3F
                return payload[1 + lang_len :].decode("utf-8", "replace")
            if header & 0x40:  # ME (message end) — last record, stop
                break
        return None
    except (IndexError, ValueError):
        return None
