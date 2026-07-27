# Spec — Marquee Tag Writer (Flipper Zero app, "Route B")

Status: **scaffold / not built.** Tracking issue: #68. Decision context: [ADR 0020](../adrs/0020-flipper-tag-authoring.md).
Scaffold lives in [`flipper/marquee-tag-writer/`](../../flipper/marquee-tag-writer/).

## 1. Purpose

A Flipper Zero app (FAP) that writes an album's `curator:album:<curatorId>` URI to a blank **NTAG213**
in one selection — no hand-typing 8-character IDs. It reads the list of albums awaiting a tag write
(exported by Curator), shows a menu, and on select composes the NDEF and writes it to a held tag.

This is the richer sibling of **Route A** (already shipped, issue #67): Curator generating `.nfc` files
you write with the stock NFC app. Route A works today; Route B is a nicer on-device UX and can close
the loop back to Curator (mark-written). See ADR 0020 for why Route A went first.

## 2. The byte contract (shared with Route A — do not diverge)

The tag carries **one NDEF well-known URI record**, wrapped in the NTAG NDEF-message TLV, in the tag's
user pages. This is the exact format Stylus reads (`packages/stylus/stylus/ndef.py`) and Curator
generates (`packages/curator/src/tags/flipper-nfc.ts`, byte-for-byte tested, cross-checked against
Stylus's parser). **The FAP must produce identical bytes.** For `curator:album:2k7bxq9m`:

```
TLV:     03 1B <ndef-message> FE
message: D1 01 17 55 00 <ascii "curator:album:2k7bxq9m">
         │  │  │  │  └ URI prefix code 0x00 (no abbreviation — custom scheme)
         │  │  │  └ type 'U' (URI record)
         │  │  └ payload length (0x17 = 23 = 1 prefix + 22 ascii)
         │  └ type length (1)
         └ record header: MB|ME|SR, TNF=0x01 (well-known)
```

Laid into NTAG213 pages: page 3 = CC `E1 10 12 00`; the TLV starts at page 4, zero-padded; the URI is
always 22 chars (`curator:album:` + 8-char id), so the TLV is a fixed 30 bytes and fits user memory
(pages 4–39, 144 bytes) trivially. `ndef_build_uri_tlv()` in the scaffold implements this in C; keep it
byte-identical to `ndefUriTlv()` in Route A. (A cheap way to stay honest: paste the C output hex into
the same round-trip check Route A/Stylus use.)

> **Card kind (2026-07-24, [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md)).** A **card**
> sticker carries `curator:card:<id>` instead of `curator:album:<id>` — same format, one byte shorter
> (21 chars → a fixed **29-byte** TLV, `Page 4: 03 1A …`). The FAP should offer writing either kind;
> Route A's `flipperNfcFile(curatorId, "card")` / `GET /api/albums/:id/tag.nfc?object=card` already do.
> Stylus reads both (`curator:(album|card)`); Conductor/Backdrop treat them alike, only Amp streams the
> card over Sonos.

## 3. Input — the pending list from Curator

Curator exposes the albums awaiting a tag write (issue #67):

- `GET /api/tags/pending` → `{ pending: [{ curatorId, name, artist }] }`.

The FAP has no network, so the flow is **export → copy to SD**: Curator writes a simple file the app
reads from the Flipper's storage, e.g. `/ext/apps_data/marquee_tag_writer/pending.csv`:

```
curatorId,name,artist
2k7bxq9m,Purple Rain,Prince
aaaa1111,1999,Prince
```

(Adding a "Download tag list" button/route to Curator that emits this CSV is a small Route A follow-up;
until then, hand-create the file or paste from `/api/tags/pending`.)

## 4. UX

1. **Menu** — a Submenu listing `name — artist` from the CSV (curatorId carried per item).
2. **Select** → a "Hold a blank NTAG213 to the Flipper" popup.
3. **Write** — compose the NDEF (§2), write the user pages to the tag via the NFC API, verify by
   reading back the URI.
4. **Confirm** — success screen; optionally strike the album from the list. Back to the menu.

Nice-to-haves (later): mark-written callback to Curator (needs connectivity — out of scope for v1,
the phone/desktop marks it, issue #55); a "wrote N of M" progress counter.

## 5. Build & run

Standard FAP via **ufbt** (see the scaffold README):

```sh
cd flipper/marquee-tag-writer
ufbt            # build → dist/marquee_tag_writer.fap
ufbt launch     # build + flash + run on a USB-connected Flipper
ufbt cli        # serial console for logs
```

Pin the SDK to your firmware channel (`ufbt update --channel=release|rc|dev`, or a custom-firmware
SDK). The NFC API is **firmware-version-sensitive** — this is the main integration risk (§6).

## 6. Open questions / risks (read before picking up)

- **NFC write API churn.** The Flipper NFC stack was reworked around fw 1.0; the write path
  (`NfcDevice` / `Iso14443_3a` / `MfUltralight` poller) differs across official vs Momentum/Unleashed/
  RogueMaster. The scaffold **stubs the write call** with a clear TODO — wiring it against the target
  firmware's headers is the real work. Start by getting a bare "write 4 bytes to page 4" working, then
  layer the NDEF.
- **Write-to-blank behavior.** Confirm the app can write user pages (4+) to a factory-blank NTAG213
  (UID is factory-locked and irrelevant). Same validation Route A needs.
- **Lock/password pages.** Never write the lock bytes (page 2 / page 40) or PWD/PACK (43/44) — those
  are one-way; a bad write bricks the tag. Write only NDEF data pages.
- **CC page.** A factory NTAG213 usually ships with CC `E1 10 12 00` already set; write it only if
  absent (and never clear bits — CC is one-way).
- **List format.** CSV vs a Curator-native `.txt`/JSON — pick the simplest the app can parse with the
  storage API.

## 7. Definition of done

- Selecting an album and holding a blank NTAG213 writes a tag that **Stylus reads as the album URI**
  (validate: write → the runbook's Flipper "Read/verify" step → real scan on the stand).
- The composed bytes match Route A's `ndefUriTlv` exactly (§2).
- README documents build + the firmware channel it was validated against.
- Update this spec's status + ADR 0020 when it lands.
