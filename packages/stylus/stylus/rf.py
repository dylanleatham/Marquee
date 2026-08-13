"""PN532 RF analog front-end settings (stylus-spec §10, [ADR 0075]).

Stylus used to poll at whatever transmit drive the PN532 powered up with. On the real stand that
default **overcouples**: a tag close to the antenna detunes the reader's resonant circuit and
swamps its receiver, so the tag's load-modulated reply can't be demodulated and the reader reports
an empty field. A card lying on the reader read 0/6 — and so did every distance out to 3cm
([#303](https://github.com/dylanleatham/Marquee/issues/303)).

It presents as dead hardware, and every cheap check says the hardware is fine: the chip answers on
I²C, the firmware reports, the communication-line test echoes, and the **antenna self-test passes**
— that one measures the antenna with no tag in the field, so overcoupling is invisible to it. The
only thing that moves is backing off the transmit drive, which is what this module does.

Two of the eleven analog bytes carry the drive; the rest are the chip defaults, restated here so a
change to one is never an accidental change to the others.
"""

from __future__ import annotations

from collections.abc import Callable

# PN532 User Manual §7.3.1, RFConfiguration item 0x0A — "analog settings for the baudrate 106 kbps
# type A", in wire order:
#   RFCfg, GsNOn, CWGsP, ModGsP, DemodOwn, RxThreshold, DemodNoOwn, GsNOff, ModWidth, MifNFC,
#   TxBitPhase
# These are the chip's power-on values. Index 1 (GsNOn) and index 2 (CWGsP) are the transmit-drive
# conductances this module overrides; the other nine are passed through untouched.
ANALOG_106A_DEFAULTS: tuple[int, ...] = (
    0x59,
    0xF4,
    0x3F,
    0x11,
    0x4D,
    0x85,
    0x61,
    0x6F,
    0x26,
    0x62,
    0x87,
)

RFCONFIGURATION = 0x32
ITEM_ANALOG_106A = 0x0A

_GSN_ON = 1
_CW_GSP = 2


def one_byte(name: str, value: int) -> int:
    """Guard a value that is about to become a literal byte on the wire.

    Lives here rather than in :class:`~stylus.config.RfConfig` because this is where the constraint
    comes from — the chip takes one byte — and :class:`RfConfig` calls it. One definition, so the
    config knob and a direct :func:`configure_tx_drive` call can't disagree about what is legal.
    """
    if not 0 <= value <= 0xFF:
        raise ValueError(f"rf.{name} must be a single byte (0x00-0xFF), got {value:#x}")
    return value


def analog_106a_params(gsn_on: int, cw_gsp: int) -> list[int]:
    """The 11 analog bytes: chip defaults with the two transmit-drive conductances overridden.

    ``gsn_on`` is the N-driver conductance while the field is on (high nibble CWGsN, low nibble
    ModGsN); ``cw_gsp`` is the P-driver conductance for the continuous wave. Lower means a weaker
    field, which is the whole point — see the module docstring.
    """
    params = list(ANALOG_106A_DEFAULTS)
    params[_GSN_ON] = one_byte("gsn_on", gsn_on)
    params[_CW_GSP] = one_byte("cw_gsp", cw_gsp)
    return params


def configure_tx_drive(call_function: Callable[..., object], gsn_on: int, cw_gsp: int) -> None:
    """Apply the transmit drive to the chip via ``RFConfiguration``.

    Takes the driver's ``call_function`` rather than the driver, so the command that goes on the
    wire is checkable without a PN532 attached. The settings are volatile: they live until the chip
    is reset or power-cycled, which is why this is issued on every boot rather than once by hand.
    """
    call_function(
        RFCONFIGURATION,
        params=bytearray([ITEM_ANALOG_106A, *analog_106a_params(gsn_on, cw_gsp)]),
        response_length=0,
    )
