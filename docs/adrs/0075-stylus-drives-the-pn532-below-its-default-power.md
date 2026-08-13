# ADR 0075 — Stylus drives the PN532 below its default power

- **Status:** Accepted
- **Date:** 2026-08-12
- **Issue:** [#303](https://github.com/dylanleatham/Marquee/issues/303)
- **Supersedes/amends:** the read-range claim in [stylus-spec §10](../specs/stylus-spec.md)

## Context

Stylus stopped detecting tags. Nothing on the stand registered: lights, video and audio never
changed, and Curator's System menu showed an empty stand. A card lying **directly on the reader**
was not seen.

Every layer above the RF field was healthy, which is what made it expensive to diagnose:

- `marquee-stylus` active and polling at 200ms, with zero exceptions in 8h of journal.
- Deployed code byte-identical to `main`; the real reader was in use (not `--simulate` — and
  `create_pn532_reader()` raises rather than falling back, so there is no silent-simulation path).
- PN532 present on I²C at `0x24`, firmware v1.6.
- Diagnose `0x00` (communication line test) echoed cleanly.
- **Diagnose `0x07` (antenna self-test) passed** at both current thresholds.
- Pi power rail clean (`throttled=0x0`).
- `GET /status` reported `observed: null`. `observed` is recorded _before_ the state machine runs
  (the bring-up debugging aid added for
  [#198](https://github.com/dylanleatham/Marquee/issues/198)), so a tag that was merely undecodable
  or carrying a foreign URI would still have appeared there. The chip genuinely saw nothing.

The cause is **overcoupling**. At the PN532's power-on transmit drive, a tag near the antenna
detunes the reader's resonant circuit and swamps its receiver, so the tag's load-modulated reply
cannot be demodulated. The reader is transmitting perfectly and cannot hear the answer.

The antenna self-test cannot see this, and that is the trap: it measures antenna current with **no
tag in the field**. Every instrument that does not involve a tag reports a healthy reader.

Measured on the stand, with a card, counting _full NDEF decodes_ out of 6 (not just UID sightings):

| `GsNOn` / `CWGsP`              | touching | 1 cm    | 2 cm    | 3 cm    |
| ------------------------------ | -------- | ------- | ------- | ------- |
| `0xF4` / `0x3F` (chip default) | 0/6      | 0/6     | 0/6     | 0/6     |
| **`0x84` / `0x18`**            | **6/6**  | **6/6** | **6/6** | **6/6** |
| `0x44` / `0x08`                | 6/6      | 6/6     | 6/6     | 6/6     |

A sweep of all eight `RxGain` values changed nothing (0/6 everywhere, 1/6 at the chip default), so
this is the transmit drive and not receiver sensitivity.

Stylus had never issued `RFConfiguration` at all — it inherited whatever the chip powered up with,
with no config knob and no way to observe the applied values at runtime. Mount and range tuning
(spec §11 milestone #6) was the one Stylus milestone still open; this is that milestone's failure
mode arriving in production as "the whole thing is dead."

## Decision

**Stylus configures the PN532's transmit drive on every boot, and defaults it below the chip's
power-on value.**

1. `RFConfiguration` item `0x0A` (analog settings, 106kbps type A) is issued after
   `SAM_configuration` and before the first poll, with `GsNOn = 0x84` and `CWGsP = 0x18`. The other
   nine analog bytes are the chip defaults, restated in `stylus/rf.py` so that changing one is never
   an accidental change to the others.
2. The drive is a config knob — `[rf] gsn_on` / `cw_gsp` in `config.toml` — so tuning a different
   mount is a config edit, not a code change. Values are validated as single bytes.
3. `GET /status` reports the drive in force under `rf`. The settings are volatile, so "what the
   config file says" is a different question from "what the chip is doing".
4. The setup sequence moved out of the hardware factory into `build_pn532_reader(pn532, rf)`, which
   takes an injected chip object. `create_pn532_reader` is now imports and construction only.

We chose `0x84`/`0x18` over the equally-working `0x44`/`0x08` because both fix contact reads and the
milder reduction keeps more maximum-range headroom.

## Consequences

- **Maximum read range is lower than the chip's default would give in free air.** This is the
  intended trade: measured range on the actual mount went from unusable to 6/6 everywhere tested.
  Spec §10's "~4cm max, ~2cm reliably" was written from the datasheet, not from this stand, and is
  corrected there.
- **A different mount may need different values.** That is why it is config, and why `/status`
  reports it. The direction is documented in `config.example.toml`: move _down_ when tags fail close
  in, _up_ when they fail only far away.
- **The blind spot is closed structurally.** Point 4 is the durable half. The defect lived inside a
  `# pragma: no cover` hardware factory, which is precisely where
  [#170](https://github.com/dylanleatham/Marquee/pull/170),
  [#174](https://github.com/dylanleatham/Marquee/pull/174),
  [#176](https://github.com/dylanleatham/Marquee/pull/176) and
  [#232](https://github.com/dylanleatham/Marquee/pull/232) also lived. A fake chip now asserts that
  the drive is applied, that it is applied _before_ the first poll, and that it carries the
  configured values — the missing configuration step is a test failure, not a field report.
- **Diagnostic note worth keeping:** a passing PN532 antenna self-test does not mean the reader can
  read. It measures the antenna with no tag present, so it is blind to the entire class of
  coupling faults. `observed: null` in `/status` with a tag physically on the reader is the signal
  that separates "sees nothing" from "sees something it won't accept".
