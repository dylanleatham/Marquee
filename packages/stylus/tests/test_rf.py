"""RF analog front-end configuration (stylus-spec §10, [ADR 0075], issue #303).

The bug these guard: ``create_pn532_reader`` never issued ``RFConfiguration`` at all, so the chip
polled at whatever transmit drive it powered up with. On the real stand that default overcouples —
a card lying on the reader detunes the resonant circuit and the reader sees *nothing*, at every
distance from contact out to 3cm. It looked like dead hardware: the antenna self-test passes,
because it measures the antenna with no tag in the field.

Everything below is the pure/injectable half of that seam, so the fact and the order of the
configuration are testable off-Pi — the hardware factory is left as nothing but imports.
"""

import pytest

from stylus.app import StylusApp
from stylus.config import Config, RfConfig, config_from_dict
from stylus.reader import SimulatedReader, build_pn532_reader
from stylus.rf import (
    ANALOG_106A_DEFAULTS,
    ITEM_ANALOG_106A,
    RFCONFIGURATION,
    analog_106a_params,
    configure_tx_drive,
)

CARD = "curator:card:h1zvqyvw"


def _tag_pages(uri: str) -> dict[int, bytes]:
    """A written NTAG213's user memory as the PN532 hands it back: 4 bytes per page from page 4."""
    payload = b"\x00" + uri.encode()
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload
    tlv = bytes([0x03, len(record)]) + record + b"\xfe"
    mem = tlv.ljust(144, b"\x00")
    return {4 + i: mem[i * 4 : i * 4 + 4] for i in range(36)}


class _NullPublisher:
    def publish(self, event):
        return {}


class _NullLed:
    def set(self, pattern):
        pass


class FakePn532:
    """Records the command sequence a real PN532 would receive."""

    def __init__(self, uid: bytes | None = None, pages: dict[int, bytes] | None = None) -> None:
        self.calls: list[tuple] = []
        self._uid = uid
        self._pages = pages or {}

    def SAM_configuration(self) -> None:  # noqa: N802 - mirrors the adafruit driver's name
        self.calls.append(("SAM",))

    def call_function(self, command, params=None, response_length=0):
        self.calls.append(("call", command, list(params or []), response_length))
        return b""

    def read_passive_target(self, timeout=0.05):
        return self._uid

    def ntag2xx_read_block(self, page):
        return self._pages.get(page)


# --- the payload ----------------------------------------------------------------------------------


def test_analog_params_override_only_the_two_tx_drive_bytes():
    params = analog_106a_params(0x84, 0x18)
    assert len(params) == 11, "RFConfiguration item 0x0A takes exactly 11 bytes"
    assert params == [ANALOG_106A_DEFAULTS[0], 0x84, 0x18, *ANALOG_106A_DEFAULTS[3:]]


def test_analog_params_default_to_the_chip_defaults():
    assert analog_106a_params(ANALOG_106A_DEFAULTS[1], ANALOG_106A_DEFAULTS[2]) == list(
        ANALOG_106A_DEFAULTS
    )


def test_configure_tx_drive_issues_rfconfiguration_item_0a():
    fake = FakePn532()
    configure_tx_drive(fake.call_function, 0x84, 0x18)
    ((kind, command, params, _),) = fake.calls
    assert kind == "call"
    assert command == RFCONFIGURATION
    assert params == [ITEM_ANALOG_106A, *analog_106a_params(0x84, 0x18)]


@pytest.mark.parametrize("gsn_on,cw_gsp", [(-1, 0x18), (0x100, 0x18), (0x84, -1), (0x84, 0x100)])
def test_configure_tx_drive_rejects_values_that_are_not_one_byte(gsn_on, cw_gsp):
    # A hand-edited config that overflows a byte would otherwise be sent to the chip verbatim.
    with pytest.raises(ValueError):
        configure_tx_drive(FakePn532().call_function, gsn_on, cw_gsp)


# --- the wiring -------------------------------------------------------------------------------------


def test_build_reader_configures_tx_drive_before_it_ever_polls():
    """#303 itself: the factory used to skip this entirely and inherit the chip's default drive."""
    fake = FakePn532()
    build_pn532_reader(fake, RfConfig(gsn_on=0x84, cw_gsp=0x18))
    assert [c[0] for c in fake.calls] == ["SAM", "call"], "SAM first, then the analog settings"
    assert fake.calls[1][1] == RFCONFIGURATION
    assert fake.calls[1][2] == [ITEM_ANALOG_106A, *analog_106a_params(0x84, 0x18)]


def test_build_reader_sends_the_configured_values_not_hardcoded_ones():
    fake = FakePn532()
    build_pn532_reader(fake, RfConfig(gsn_on=0x44, cw_gsp=0x08))
    assert fake.calls[1][2] == [ITEM_ANALOG_106A, *analog_106a_params(0x44, 0x08)]


def test_built_reader_still_polls_and_decodes():
    fake = FakePn532(uid=b"\x04\x48\x33", pages=_tag_pages(CARD))
    reader = build_pn532_reader(fake, RfConfig())
    tag = reader.poll()
    assert tag is not None
    assert tag.uid == "04:48:33"
    assert tag.uri == CARD


def test_built_reader_reports_an_empty_field_as_none():
    reader = build_pn532_reader(FakePn532(uid=None), RfConfig())
    assert reader.poll() is None


def _counting_pages(fake: FakePn532) -> list[int]:
    """Record every page the reader actually pulls off the tag."""
    pages: list[int] = []
    inner = fake.ntag2xx_read_block
    fake.ntag2xx_read_block = lambda page: (pages.append(page), inner(page))[1]  # type: ignore[method-assign]
    return pages


def test_a_built_reader_keeps_its_decode_across_a_dropped_poll():
    """regression: #337 — a card that never moved replayed from track 1 every ~20s.

    Asserted through the *factory* rather than on ``UriCache`` alone, because the factory is the
    seam that has repeatedly shipped unwired here (#303, #307, #232): a threshold that never
    reaches the cache would leave the unit tests green and the stand still cycling.
    """
    fake = FakePn532(uid=b"\x04\x48\x33", pages=_tag_pages(CARD))
    pages = _counting_pages(fake)
    reader = build_pn532_reader(fake, RfConfig(), forget_after_absent_polls=10)

    assert reader.poll().uri == CARD
    settled = len(pages)
    assert settled > 0, "the first sighting has to actually read the tag"

    fake._uid = None  # one marginal poll — the card is still sitting on the stand
    assert reader.poll() is None
    fake._uid = b"\x04\x48\x33"

    assert reader.poll().uri == CARD
    assert len(pages) == settled, "a sub-debounce dropout must not force an NDEF re-read"


def test_a_built_reader_re_reads_once_the_removal_debounce_is_met():
    """The boundary's other side: a real lift must still invalidate, or #232 comes back."""
    fake = FakePn532(uid=b"\x04\x48\x33", pages=_tag_pages(CARD))
    pages = _counting_pages(fake)
    reader = build_pn532_reader(fake, RfConfig(), forget_after_absent_polls=10)

    assert reader.poll().uri == CARD
    settled = len(pages)

    fake._uid = None
    for _ in range(10):
        assert reader.poll() is None
    fake._uid = b"\x04\x48\x33"

    assert reader.poll().uri == CARD
    assert len(pages) > settled, "a confirmed removal must drop the cached decode"


# --- the config knob --------------------------------------------------------------------------------


def test_rf_defaults_to_the_measured_good_drive_not_the_chip_default():
    # 0x84/0x18 read 6/6 from contact to 3cm; the chip's 0xF4/0x3F read 0/6 at every distance.
    cfg = config_from_dict({})
    assert (cfg.rf.gsn_on, cfg.rf.cw_gsp) == (0x84, 0x18)
    assert (cfg.rf.gsn_on, cfg.rf.cw_gsp) != (ANALOG_106A_DEFAULTS[1], ANALOG_106A_DEFAULTS[2])


def test_rf_section_overrides_the_drive():
    cfg = config_from_dict({"rf": {"gsn_on": 0x44, "cw_gsp": 0x08}})
    assert (cfg.rf.gsn_on, cfg.rf.cw_gsp) == (0x44, 0x08)


@pytest.mark.parametrize("section", [{"gsn_on": 0x1FF}, {"cw_gsp": -1}])
def test_rf_config_rejects_values_that_are_not_one_byte(section):
    with pytest.raises(ValueError):
        config_from_dict({"rf": section})


def test_status_reports_the_transmit_drive_in_force():
    """Diagnosing #303 needed the service stopped, because /status never said what drive was set."""
    app = StylusApp(
        Config(rf=RfConfig(gsn_on=0x44, cw_gsp=0x08)),
        SimulatedReader(),
        _NullPublisher(),
        _NullLed(),
    )
    assert app.status()["rf"] == {"gsnOn": 0x44, "cwGsp": 0x08}
