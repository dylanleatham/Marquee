from stylus.ndef import parse_uri
from stylus.reader import SimulatedReader, UriCache, assemble_ntag_ndef
from stylus.state_machine import TagRead

CARD = "curator:card:frn453tp"


def _tag_pages(uri: str) -> dict[int, bytes]:
    """A written NTAG213's user memory as the PN532 hands it back: 4 bytes per page from page 4."""
    payload = b"\x00" + uri.encode()
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload
    tlv = bytes([0x03, len(record)]) + record + b"\xfe"
    mem = tlv.ljust(144, b"\x00")  # 36 user pages
    return {4 + i: mem[i * 4 : i * 4 + 4] for i in range(36)}


# An NDEF message carrying a Text record with `curator:album:2k7bxq9m`, as a phone writes it.
def _ndef_text(uri: bytes) -> bytes:
    payload = b"\x02en" + uri
    return bytes([0xD1, 0x01, len(payload), 0x54]) + payload


BLANK = b"\x00\x00\x00\x00"
WRITTEN = _ndef_text(b"curator:album:2k7bxq9m")


def test_simulated_reader_set_clear_poll():
    r = SimulatedReader()
    assert r.poll() is None
    r.set_tag("04:A1", "curator:album:2k7bxq9m")
    assert r.poll() == TagRead("04:A1", "curator:album:2k7bxq9m")
    r.clear()
    assert r.poll() is None


def test_assemble_stops_at_terminator():
    pages = {
        4: b"\x03\x10\xd1\x01",  # TLV + record start
        5: b"\x0cUcura",
        6: b"tor:al\xfe\x00",  # 0xFE terminator inside this page
        7: b"SHOULDNOTREAD",
    }
    out = assemble_ntag_ndef(lambda p: pages.get(p))
    assert out.endswith(b"\xfe\x00") or 0xFE in out
    assert b"SHOULDNOTREAD" not in out


def test_assemble_stops_when_read_fails():
    pages = {4: b"AAAA", 5: b"BBBB"}  # page 6 missing → read returns None
    out = assemble_ntag_ndef(lambda p: pages.get(p))
    assert out == b"AAAABBBB"


def test_assemble_reads_a_whole_card_uri_and_stops_at_the_declared_length():
    pages = _tag_pages(CARD)
    read = []
    out = assemble_ntag_ndef(lambda p: (read.append(p), pages.get(p))[1])
    assert parse_uri(out) == CARD
    assert read[-1] == 10  # the message ends on page 10; the other 29 pages are never touched


def test_a_dropped_page_read_is_retried_rather_than_truncating_the_uri():
    """The stand read `curator:card:frn453tp` as `curator:c`: one page read failed four pages in,
    assembly stopped there, and the prefix decoded as a shorter but perfectly valid URI. One flaky
    I²C read must not become a different album."""
    pages = _tag_pages(CARD)
    flaky = {8: 1}  # page 8 fails once, then answers

    def read_page(p):
        if flaky.get(p):
            flaky[p] -= 1
            return None
        return pages.get(p)

    assert parse_uri(assemble_ntag_ndef(read_page)) == CARD


def test_a_page_that_never_answers_reads_as_no_tag_not_a_short_uri():
    pages = _tag_pages(CARD)
    out = assemble_ntag_ndef(lambda p: None if p == 8 else pages.get(p))
    assert len(out) == 16  # exactly the read that produced `curator:c`
    assert parse_uri(out) is None  # …and it is now a failed decode, so nothing gets cached


def test_assemble_does_not_stop_on_an_0xfe_payload_byte():
    # 0xFE is a legal byte inside a payload; only the TLV's own length says where the message ends.
    payload = b"\x00" + b"\xfe" * 8
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload
    tlv = bytes([0x03, len(record)]) + record + b"\xfe"
    mem = tlv.ljust(144, b"\x00")
    pages = {4 + i: mem[i * 4 : i * 4 + 4] for i in range(36)}
    out = assemble_ntag_ndef(lambda p: pages.get(p))
    assert out.startswith(tlv)


def test_assemble_respects_max_pages():
    out = assemble_ntag_ndef(lambda p: b"XXXX", start_page=4, max_pages=3)
    assert out == b"XXXX" * 3


# --- UriCache --------------------------------------------------------------------------------------


def test_cache_reads_once_per_uid_then_serves_from_memory():
    reads = []

    def read():
        reads.append(1)
        return WRITTEN

    cache = UriCache()
    assert cache.get_or_read("04:AA", read) == "curator:album:2k7bxq9m"
    assert cache.get_or_read("04:AA", read) == "curator:album:2k7bxq9m"
    assert len(reads) == 1  # the slow NDEF read happened once, not per poll


def test_a_tag_written_after_we_first_saw_it_blank_is_picked_up():
    # The step-11 bug: writing NDEF to a tag does NOT change its UID, so caching the miss meant a
    # freshly-written sleeve stayed invisible until the service was restarted.
    content = [BLANK]
    cache = UriCache()

    assert cache.get_or_read("04:AA", lambda: content[0]) is None
    content[0] = WRITTEN  # operator writes the tag with their phone
    assert cache.get_or_read("04:AA", lambda: content[0]) == "curator:album:2k7bxq9m"


def test_misses_are_re_read_every_time():
    reads = []

    def read():
        reads.append(1)
        return BLANK

    cache = UriCache()
    for _ in range(3):
        assert cache.get_or_read("04:AA", read) is None
    assert len(reads) == 3  # deliberate: a miss must never be remembered


def test_cache_evicts_wholesale_past_max_size():
    cache = UriCache(max_size=2)
    for uid in ("04:A", "04:B", "04:C"):
        cache.get_or_read(uid, lambda: WRITTEN)
    reads = []

    def read():
        reads.append(1)
        return WRITTEN

    cache.get_or_read("04:A", read)
    assert len(reads) == 1  # cleared when it filled, so the oldest entry is gone
