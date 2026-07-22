# Marquee Tag Writer (Flipper Zero) — scaffold

Write an album's `curator:album:<id>` NDEF URI to a blank **NTAG213** by picking it from a list — no
hand-typing 8-char IDs. This is **"Route B"** (issue #68); the shipped, no-app alternative is **Route
A** (Curator generates `.nfc` files you write with the stock NFC app — issue #67). See
[ADR 0020](../../docs/adrs/0020-flipper-tag-authoring.md) for why A shipped first.

> **Status: scaffold, not built.** The GUI + the NDEF byte-compose are real; **the NFC write and the
> pending-list loading are TODOs** (firmware-version-sensitive). Full plan:
> [docs/specs/flipper-tag-writer.md](../../docs/specs/flipper-tag-writer.md).

## Build

Uses **ufbt** (micro Flipper Build Tool). It needs a real desktop toolchain and, to flash/test, a
Flipper on USB — so this is picked up in a **local Claude Code / dev session on your machine**, not
the remote sandbox.

```sh
pipx install ufbt          # or: pip install --user ufbt
cd flipper/marquee-tag-writer
ufbt update --channel=release   # pull the SDK for your firmware (release|rc|dev, or a custom-FW SDK)
ufbt                            # build → dist/marquee_tag_writer.fap
ufbt launch                     # build + flash + run on a USB-connected Flipper
ufbt cli                        # serial console (FURI_LOG output)
```

Match `--channel` to the firmware on your Flipper (official, or a custom-FW SDK for Momentum /
Unleashed / RogueMaster). The **NFC write API differs across these** — that's the main integration
risk.

## Picking this up across sessions — start here

1. Read the **spec** (`docs/specs/flipper-tag-writer.md`) — especially §2 (byte contract) and §6
   (risks). The byte layout is fixed and shared with Route A; don't reinvent it.
2. In `marquee_tag_writer.c`, the two TODOs are the whole job:
   - **`load_pending_albums()`** — parse the Curator-exported CSV from SD
     (`/ext/apps_data/marquee_tag_writer/pending.csv`) instead of the hardcoded sample.
   - **`nfc_write_ntag_pages()`** — the real write. Strategy: get a bare *"write 4 bytes to page 4"*
     working against your firmware's NFC headers first (official fw: `NfcDevice` +
     `Iso14443_3aPoller` / `MfUltralightPoller`), verify with a read-back, **then** feed the TLV from
     `marquee_build_ndef_tlv()`. Never write lock/CC/PWD pages (spec §6).
3. **Validate the whole chain**, not just the write: write a tag → the runbook's Flipper "Read/verify"
   step shows `curator:album:<id>` → a real scan on the stand drives the room. The compose is already
   pinned to what Stylus reads (Route A's tests cross-check the identical bytes against Stylus's
   parser), so if a written tag doesn't scan, the bug is in the write/page-layout, not the NDEF.
4. When it works: note the firmware channel you validated against here, flip the spec's status, and
   update ADR 0020.

## Layout

- `application.fam` — app manifest (ufbt reads this).
- `marquee_tag_writer.c` — single-file app: NDEF compose (done) + GUI (submenu/popup) + the two TODOs.
