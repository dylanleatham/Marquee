from stylus.ndef import parse_uri

ALBUM = "curator:album:2k7bxq9m"


def _record(tnf: int, rtype: bytes, payload: bytes, mb=True, me=True, sr=True) -> bytes:
    header = tnf & 0x07
    if mb:
        header |= 0x80  # message begin
    if me:
        header |= 0x40  # message end
    if sr:
        header |= 0x10  # short record
    out = bytes([header, len(rtype)])
    out += bytes([len(payload)]) if sr else len(payload).to_bytes(4, "big")
    return out + rtype + payload


def uri_record(uri: str, prefix_code: int = 0x00, prefix: str = "") -> bytes:
    rest = uri[len(prefix) :]
    return _record(0x01, b"U", bytes([prefix_code]) + rest.encode())


def tlv_wrap(message: bytes) -> bytes:
    return bytes([0x03, len(message)]) + message + bytes([0xFE])


def test_parses_custom_scheme_uri_no_prefix():
    assert parse_uri(uri_record(ALBUM)) == ALBUM


def test_parses_uri_wrapped_in_ndef_message_tlv():
    assert parse_uri(tlv_wrap(uri_record(ALBUM))) == ALBUM


def test_skips_lock_control_tlv_before_ndef_message():
    lock_tlv = bytes([0x01, 0x03, 0x00, 0x00, 0x00])  # type=0x01, len=3, value
    raw = lock_tlv + tlv_wrap(uri_record(ALBUM))
    assert parse_uri(raw) == ALBUM


def test_applies_https_prefix_abbreviation():
    rec = uri_record("https://example.com", prefix_code=0x04, prefix="https://")
    assert parse_uri(rec) == "https://example.com"


def test_reads_a_text_record_fallback():
    # status byte 0x02 → UTF-8, language-code length 2 ("en"); then the text.
    payload = bytes([0x02]) + b"en" + ALBUM.encode()
    assert parse_uri(_record(0x01, b"T", payload)) == ALBUM


def test_returns_first_uri_when_multiple_records():
    first = uri_record(ALBUM, prefix_code=0x00)  # MB set, ME not
    first = bytes([first[0] & ~0x40]) + first[1:]  # clear ME on the first record
    second = uri_record("curator:album:zzzzzzzz")
    assert parse_uri(first + second) == ALBUM


def test_malformed_input_returns_none():
    assert parse_uri(b"") is None
    assert parse_uri(b"\xd1\x01") is None  # truncated header
    assert parse_uri(b"\x00\x00\x00") is None  # all-NULL TLVs, no message


def test_a_read_cut_short_mid_uri_is_a_failed_decode_not_a_shorter_uri():
    """The stand reported a real card tag as `curator:c` — the first 16 bytes of
    `curator:card:frn453tp`, decoded as if that were the whole record. It is well-formed, so it was
    cached as a successful decode and shown as a tag "carrying" a URI nobody ever wrote. Every
    truncation of a good tag must read as undecodable."""
    full = tlv_wrap(uri_record("curator:card:frn453tp"))
    assert parse_uri(full) == "curator:card:frn453tp"
    # Every prefix short of the whole message. Losing only the trailing 0xFE terminator is not a
    # truncation — the terminator sits outside the message — so the last byte is excluded.
    for n in range(1, len(full) - 1):
        assert parse_uri(full[:n]) is None, f"{n} bytes decoded to something"


def test_truncated_bare_record_returns_none():
    rec = uri_record(ALBUM)  # no TLV wrapper — the record header carries the length
    assert parse_uri(rec[: len(rec) - 1]) is None


def test_truncated_four_byte_payload_length_returns_none():
    # Long-record form: the 4-byte payload length itself is cut off mid-field.
    assert parse_uri(b"\xc1\x01\x00\x00") is None


def test_non_uri_record_returns_none():
    # A MIME (TNF 0x02) record isn't a URI/Text record → nothing to extract.
    assert parse_uri(_record(0x02, b"text/plain", b"hello")) is None


def test_parses_the_exact_bytes_curator_generates():
    """Cross-service contract (issue #67): the NTAG NDEF-message TLV Curator's Flipper `.nfc`
    generator emits for ALBUM (packages/curator/src/tags/flipper-nfc.ts, asserted byte-for-byte by
    its own test) must parse back to the album URI here. What Curator writes, Stylus reads."""
    tlv = bytes.fromhex(
        "031bd10117550063757261746f723a616c62756d3a326b37627871396dfe"
    )
    assert parse_uri(tlv) == ALBUM
