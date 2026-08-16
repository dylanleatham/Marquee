# Marquee Tag Writer (Flipper Zero)

Write an album's `curator:album:<id>` NDEF URI to a blank **NTAG213** by picking it from a list — no
hand-typing 8-char IDs. This is **"Route B"** (issue #68); the shipped, no-app alternative is **Route
A** (Curator generates `.nfc` files you write with the stock NFC app — issue #67). See
[ADR 0020](../../docs/adrs/0020-flipper-tag-authoring.md) for why A shipped first.

> **Status: working.** Validated on **official firmware 1.4.3** (2026-07-31) — write, read-back
> verify, and the on-device read/verify screen. Full plan and the hardware findings:
> [docs/specs/flipper-tag-writer.md](../../docs/specs/flipper-tag-writer.md) (§6 is the one to read
> before changing the NFC code).

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
Unleashed / RogueMaster). The **NFC write API differs across these**.

**Validated against: official firmware 1.4.3, API 87.1.** `ufbt update --channel=release` resolved to
the same 1.4.3, so the SDK and device matched exactly. On a different firmware, re-check the three
NFC findings in spec §6 — one poller session per tag, keep polling while the field is empty, and
`read_page` returning four pages per command.

## Getting the album list onto the card

The app reads `/ext/apps_data/marquee_tag_writer/pending.csv`. Curator puts it there — easiest is the
**"Send list to Flipper"** button on the Queue's _Awaiting tag write_ section (replaces the list), or
**"Add this album to Flipper"** on an album's Ship tab (merges one in). `GET /api/tags/pending.csv`
downloads the same file if you'd rather copy it across with qFlipper.

The list arrives alphabetical by album name, and the merge re-sorts the whole file, so adding records
one at a time still gives you a menu you can scroll to a letter in. The app renders CSV order as-is —
if the on-device order looks wrong, the fix is in Curator's `sortPendingRows`, not in this C.

With no CSV on the card the menu shows one entry labelled `DEMO:` so the write path is still testable.

## Changing this app — read first

1. **Spec §6** (`docs/specs/flipper-tag-writer.md`) is the hard-won part: one poller session per tag,
   keep polling while the field is empty, `read_page` returns four pages, and FAP stack sizing is
   invisible to every check in this repo. Each of those cost a hardware round-trip.
2. **The byte layout is shared with Route A and pinned by a test.**
   `packages/curator/test/flipper-c-bytes.test.ts` reads this C source and checks the compose against
   Curator's `ndefUriTlv`, so the two can't drift silently. Don't reinvent the layout; if you must
   change it, change both sides and Stylus's parser together.
3. **Nothing here is compiled by `pnpm test`.** `ufbt` is the only thing that builds this file, and a
   green repo says nothing about whether the app runs. Test on device.
4. **The last link is still unproven**: a tag written by this app has not yet been scanned on the
   stand (it needs an album in `awaiting_tag_write`). Write → read back → real scan is the full chain.

## Layout

- `application.fam` — app manifest (ufbt reads this). `stack_size` is 8 KB for a reason; see spec §6.
- `marquee_tag_writer.c` — single-file app: NDEF compose + parse, CSV loading, the NFC session, and
  the menu hierarchy (main → kind → albums → hold/confirm, plus read-a-tag).
