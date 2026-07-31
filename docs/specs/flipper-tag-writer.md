# Spec — Marquee Tag Writer (Flipper Zero app, "Route B")

Status: **built and validated on hardware** (2026-07-31), against **official firmware 1.4.3**.
Tracking issue: #68. Decision context: [ADR 0020](../adrs/0020-flipper-tag-authoring.md).
Lives in [`flipper/marquee-tag-writer/`](../../flipper/marquee-tag-writer/).

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
(pages 4–39, 144 bytes) trivially. `marquee_build_ndef_tlv()` implements this in C.

**This is enforced, not trusted.** `packages/curator/test/flipper-c-bytes.test.ts` reads the C source,
extracts the byte constants and the length arithmetic, and checks them against what `ndefUriTlv()`
actually produces — so the third leg of the contract (Curator generates, Stylus parses, the FAP
composes) cannot drift silently the way it could when "keep it byte-identical" was a comment.

> **Card kind (2026-07-24, [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md)).** A **card**
> sticker carries `curator:card:<id>` instead of `curator:album:<id>` — same format, one byte shorter
> (21 chars → a fixed **29-byte** TLV, `Page 4: 03 1A …`). The FAP offers both — "Which kind of tag?"
> is the screen after "Write a tag" (§4) — as do Route A's `flipperNfcFile(curatorId, "card")` and
> `GET /api/albums/:id/tag.nfc?object=card`. The write path derives its page count from the TLV
> length rather than assuming 30 bytes, so the shorter card TLV needs no special case.
> Stylus reads both (`curator:(album|card)`); Conductor/Backdrop treat them alike, only Amp streams the
> card over Sonos.

## 3. Input — the pending list from Curator

Curator exposes the albums awaiting a tag write (issue #67):

- `GET /api/tags/pending` → `{ pending: [{ curatorId, name, artist }] }`.

The FAP has no network, so Curator puts the list on the card. Three ways in, all writing
`/ext/apps_data/marquee_tag_writer/pending.csv`:

- **`POST /api/tags/push-to-flipper`** — the Queue's "Send list to Flipper" button. **Replaces** the
  list with the whole `awaiting_tag_write` queue.
- **`POST /api/albums/:curatorId/push-to-flipper`** — the Ship tab's "Add this album to Flipper".
  **Merges** one album in, keyed on `curatorId`, so pressing it twice does not duplicate a row.
- **`GET /api/tags/pending.csv`** — download it and copy it across by hand (qFlipper), for when
  Curator isn't on the machine the Flipper is plugged into.

The push talks the Flipper's plain-text serial CLI (`storage write_chunk`), not the protobuf RPC.
Two behaviours of that CLI are load-bearing and cost a hardware round-trip each to find:

- **`write_chunk` appends** to an existing file rather than truncating. The push does `storage remove`
  first; without it, a re-push left both copies (84 bytes onto 105 gave 189).
- **Sync on the command echo, never on the prompt.** The device prints a connect banner ending in a
  prompt, and a bare newline yields _two_ prompts — so "read until the next prompt" can return output
  that merely arrived first. That made the read-back answer empty, silently turning the Ship tab's
  append into a replace. File contents are then read by the **byte count** the device reports, because
  the payload itself can contain `>: `.

The file:

```
curatorId,name,artist
2k7bxq9m,Purple Rain,Prince
aaaa1111,1999,Prince
```

Commas, quotes and newlines are stripped from `name` and `artist` at the source, so the reader's
split-on-the-first-two-commas is always exact; only `curatorId` has to survive verbatim, and it is
base32 by construction.

## 4. UX

A hierarchy, one screen per decision — mode choices are their own screens rather than rows mixed into
the album list, because that list is data, not controls. Back pops exactly one level.

```
Marquee Tag Writer
├─ Write a tag
│    └─ Which kind of tag?
│         ├─ Sleeve (album)  →  Pick album  →  hold tag  →  confirm
│         └─ Card (Sonos)    →  Pick album  →  hold tag  →  confirm
└─ Read a tag                →  hold tag  →  shows the URI on it
```

1. **Kind** — sleeve (`curator:album:`) or card (`curator:card:`, ADR 0034). The choice follows you
   forward: the album list's header reads "Sleeve tag - pick album", and the confirmation says which
   kind was written. A kind chosen once and then forgotten is how you write forty wrong tags.
2. **Album** — a Submenu of `name - artist` from the CSV (curatorId carried per item). ASCII only —
   the Flipper font has no glyphs for UTF-8, so non-ASCII is replaced with `?`.
3. **Write** — compose the NDEF (§2) and write the user pages, then read back and compare before
   claiming success.
4. **Confirm** — "Sleeve tag written" / "Card tag written", or a named failure (`No tag seen`,
   `Write failed`, `Tag unusable`, `Wrote, verify failed`).
5. **Read a tag** — reads user memory, parses the NDEF, and shows the URI plus the matching album name
   from the list. This is how you check a tag you just wrote without walking to the stand.

With no `pending.csv` on the card the menu shows a single entry labelled `DEMO:` — clearly marked, so
the write path stays exercisable during bring-up without a fake album ever passing for a real one.

Nice-to-haves (later): mark-written callback to Curator (needs connectivity — out of scope for v1,
the phone/desktop marks it, issue #55); a "wrote N of M" progress counter.

## 5. Build & run

Standard FAP via **ufbt** (see the app's README):

```sh
cd flipper/marquee-tag-writer
ufbt            # build → dist/marquee_tag_writer.fap
ufbt launch     # build + flash + run on a USB-connected Flipper
ufbt cli        # serial console for logs
```

Pin the SDK to your firmware channel (`ufbt update --channel=release|rc|dev`, or a custom-firmware
SDK). The NFC API is **firmware-version-sensitive** — this is the main integration risk (§6).

## 6. What the hardware actually established (2026-07-31)

These were open risks; they are now findings, verified on **official firmware 1.4.3** (`ufbt
--channel=release` resolved to the same 1.4.3, API 87.1 — no custom-firmware divergence to handle).
Anything picking this up on a different firmware should re-check the first three.

- **One poller session per tag, not one per operation.** The `mf_ultralight_poller_sync_*` helpers
  each run a self-contained session (field on → activate → one op → field off) and leave the tag
  **HALTed**. Chaining them fails on the second call with `MfUltralightErrorTimeout`, which first
  showed up as "wrote OK, read FAILED" then a streak of timeouts. Every page op for one tag happens
  inside a single `nfc_poller_start` callback, using `mf_ultralight_poller_{read,write}_page`.
- **Keep polling while the field is empty.** The callback must return `NfcCommandContinue` for events
  other than `RequestMode`; returning `NfcCommandStop` makes the app a one-shot that only works if
  the tag is already in place when you press OK.
- **`read_page` returns 4 pages (16 bytes) per command**, while `write_page` takes one page (4 bytes).
  Verifying a 30-byte TLV is therefore two reads.
- **FAP stack sizing is invisible to every check in this repo.** A 4 KB buffer on a 4 KB stack killed
  the app at launch; `ufbt` builds it happily and no test here compiles this file. The pending-list
  buffer is heap-allocated and `stack_size` is 8 KB. Treat any large local in this app as a hazard.
- **Write-to-blank works.** User pages (4+) write fine on a factory-blank NTAG213; the UID is
  factory-locked and irrelevant.
- **Lock/password pages.** Never write the lock bytes (page 2 / page 40) or PWD/PACK (43/44) — those
  are one-way; a bad write bricks the tag. Only NDEF data pages are written.
- **CC page.** A factory NTAG213 usually ships with CC `E1 10 12 00` already set. The app reads page 3
  first and writes the CC **only if absent** (never clearing bits — CC is one-way).
- **List format: CSV**, split on the first two commas. Curator's export strips commas/quotes/newlines
  from `name`/`artist` so that split is exact; only `curatorId` must survive verbatim.

## 7. Definition of done

- [x] Selecting an album and holding a blank NTAG213 writes a tag, verified by read-back on device
      (fw 1.4.3, 2026-07-31).
- [x] The composed bytes match Route A's `ndefUriTlv` exactly (§2) — pinned by
      `flipper-c-bytes.test.ts`, which reads the C source and checks it against Route A's output, so
      the two cannot drift without a red test.
- [x] README documents build + the firmware channel it was validated against.
- [x] This spec's status + [ADR 0020](../adrs/0020-flipper-tag-authoring.md) updated.
- [ ] **A written tag scanned on the stand drives the room.** Not yet done: it needs an album that has
      reached `awaiting_tag_write` (approve a preview first) and a physical scan. Everything up to the
      tag being written and read back correctly is verified; the last link is the runbook's
      "Read/verify" step plus a real scan.
