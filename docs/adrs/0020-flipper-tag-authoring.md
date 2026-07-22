# ADR 0020 — Flipper Zero tag authoring: generate `.nfc` files now, a FAP later

Status: accepted · Date: 2026-07-22 · Relates: hue-conductor tag-write flow (#55), tag runbook
(docs/runbook.md §A7) · Implements: #67 (Route A) · Scaffolds: #68 (Route B) ·
Spec: [flipper-tag-writer.md](../specs/flipper-tag-writer.md)

## Context

Onboarding writes `curator:album:<curatorId>` to an NTAG213 per album. The default path is a phone
(NFC Tools). The maintainer owns a **Flipper Zero** and wants it to make writing the **unique**
per-album URIs easier — the pain is hand-typing 8-char base32 ids, not NFC itself, and Curator already
knows exactly which albums await a tag.

Two ways to use the Flipper for this:

- **Route A — Curator generates Flipper-native `.nfc` files.** The Flipper `.nfc` format is a text
  device dump (UID, CC, `Page N: …`). Curator can emit one per album with the NDEF URI pre-laid into
  the pages; you drop it on the SD card and write a blank tag with the **stock NFC app** (Saved →
  Write). No app, no C.
- **Route B — a custom FAP.** A Flipper app that reads Curator's pending list, shows a menu, and writes
  the composed NDEF to a held tag — nicer on-device UX, and could close the loop back to Curator.

Two facts drove the ordering:

- **Testability.** Route A is pure byte generation — the NDEF/NTAG page layout can be pinned
  byte-for-byte and **cross-checked against Stylus's real parser** (`ndef.py`) with no hardware.
  Route B needs the Flipper NFC write API, which is **firmware-version-sensitive** (the stack changed
  around fw 1.0; official vs Momentum/Unleashed/RogueMaster differ) and can only be verified on a
  physical device over USB — impossible from the remote sandbox these were built in.
- **Effort vs payoff.** Route A delivers the "no hand-typing" outcome immediately; Route B is polish on
  top.

## Decision

**Ship Route A now; scaffold Route B for later.**

- **Route A (#67, done):** `packages/curator/src/tags/flipper-nfc.ts` builds the NDEF URI TLV and the
  NTAG213 pages; `GET /api/albums/:id/tag.nfc` downloads the `.nfc`, `GET /api/tags/pending` lists
  albums awaiting a write. The **page/NDEF bytes are the tested invariant** (unit-tested exact bytes +
  a round-trip, and the identical bytes are asserted through Stylus's `parse_uri`). The `.nfc` file
  *wrapper* (header schema) targets recent firmware and is isolated in one function — validate it once
  on-device (write → read back), and if a firmware wants a different schema it's a one-place edit.
- **Route B (#68, scaffold):** `flipper/marquee-tag-writer/` (manifest + single-file app: NDEF compose
  done, NFC write + list-load stubbed) plus `docs/specs/flipper-tag-writer.md`. Built with ufbt on a
  local machine with the Flipper attached. **Must reuse Route A's exact byte layout** — the spec pins
  it, so the two never diverge.

## Consequences

- Unique-URI tag authoring works today with no custom firmware/app: download `.nfc` → stock Write.
- The NDEF/NTAG byte layout is now defined once and shared three ways (Curator generates it, Stylus
  reads it, the FAP will compose it); a contract test ties Curator↔Stylus so a change can't silently
  break the tags.
- Route B is a clean, documented pickup: the risky, firmware-specific piece (the NFC write) is the only
  real work left, isolated behind a stubbed function with a start-here plan.
- Not covered: a Curator "download the pending list as CSV for the FAP" route (small Route A follow-up),
  and marking a tag written in Curator (that's the #55 tag-write flow).
