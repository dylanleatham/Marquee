from stylus.reader import SimulatedReader, assemble_ntag_ndef
from stylus.state_machine import TagRead


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


def test_assemble_respects_max_pages():
    out = assemble_ntag_ndef(lambda p: b"XXXX", start_page=4, max_pages=3)
    assert out == b"XXXX" * 3
