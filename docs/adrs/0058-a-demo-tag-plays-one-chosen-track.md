# ADR 0058 — A demo tag is a third URI kind, and the track it plays is chosen in Curator, not encoded in the tag

Status: accepted · Date: 2026-08-08 · Amends:
[runtime-overview.md](../specs/runtime-overview.md) (§5 runtime signals — a third `curator:` kind),
scan-event.schema.json (`uri` now `curator:(album|card|demo):<id>`),
[amp-spec.md](../specs/amp-spec.md) (§3 scope, §9 scan handling),
[curator-spec.md](../specs/curator-spec.md) (§7 asset shape, §8 tag writing + two new routes),
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§5 — the record page's first non-need tab),
[flipper-tag-writer.md](../specs/flipper-tag-writer.md) (§2 byte contract, §4 UX) ·
Builds on [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) (the `card` kind and Amp itself) ·
Relates: [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (the four needs),
[ADR 0027](0027-generation-is-invoked-not-pipelined.md) (fetch on demand, don't pipeline)

## Context

A **card** scan streams the whole album from track 1 ([ADR 0034](0034-amp-sonos-playback-and-card-uri.md)). That is right for
"put this record on", and wrong for the thing the maintainer actually wanted a tag for: handing
someone **one song** — the cut that makes them want to hear the rest. Today the only way to get one
song is to let the album start and skip, which is not a thing you do to a guest.

Three questions had to be answered together, because answering any one of them alone leads somewhere
different:

1. **How does the runtime know this scan is a demo?** The fan-out carries exactly one signal
   (runtime-overview §5), and Conductor, Backdrop and Amp each look up what they need from it.
2. **Where does the track choice live** — in the tag, or beside the album?
3. **Which screen makes the choice?** The record page is deliberately "the four things a record still
   needs" ([ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md)), and a demo cut is not one of them.

## Decision

**A third URI kind, `curator:demo:<id>`, plus a `demoTrack` field on the album asset. The tag says
_which behaviour_; the asset says _which song_.**

### 1. The kind rides on the URI, exactly as `card` does

`CuratorUriKind` becomes `album | card | demo` and the scan-event pattern becomes
`^curator:(album|card|demo):[a-z0-9]{8}$`. Every service already decodes through `parseCuratorUri`,
so **Conductor and Backdrop needed no code change at all** — a demo scan lights the room and plays
the visualizer identically, because the immersive half of the experience is the same record either
way. Only Amp gates on the kind.

This is [ADR 0034](0034-amp-sonos-playback-and-card-uri.md)'s reasoning reused rather than re-litigated: the sticker's own bytes decide,
so nothing depends on optional bookkeeping being present and correct. It also rejects the same
alternative for the same reason — gating on `tag.demo.tagUid` would depend on a field that is often
absent.

The kinds are now enumerated as `CURATOR_URI_KINDS` in `@marquee/contracts`, and the contract tests
iterate it rather than restating a list. That is the durable half: a fourth kind is covered by the
round-trip and schema tests the moment it is declared, instead of when someone remembers.

### 2. The chosen track lives on the asset, not in the tag

`asset.demoTrack = { spotifyUri, name, trackNumber?, durationMs?, chosenAt }`. Amp reads it from the
synced store at scan time, exactly as it already reads `metadata.spotifyUri`.

- **Not encoded in the URI.** A `curator:demo:<id>:07` would mean re-writing a physical sticker to
  change your mind, and would widen a pattern five services share for data only one of them reads.
- **Only the choice is stored, never the tracklist.** The picker fetches it live from
  `GET /api/albums/:id/tracks`. The album-assets store is in git (runtime-overview §4) and holds
  hundreds of records; twelve rows per album to support one pick would bloat every diff with data
  Spotify already answers. This is [ADR 0027](0027-generation-is-invoked-not-pipelined.md)'s "invoked, not pipelined" applied to a read.
- The Spotify page loop is **bounded** (4 × 50 = 200 tracks) rather than following `next` to the end,
  per the always-on rule in CLAUDE.md.

### 3. No chosen track falls back to the album, and is never silent

A demo scan with no `demoTrack` plays the whole album — byte-identical behaviour to a card.

The alternative, and the one initially proposed, was a `202 { action:"ignored", reason:"no demo track
chosen" }` alongside Amp's other degradations. Rejected: a demo tag is written before, or entirely
independently of, the choice being made, and **a tag that does nothing is indistinguishable from a
mis-written one**. Standing at the stand, a record playing from track 1 is a wrong you can hear and
go fix; silence sends you to `journalctl`. The scan response carries `demoTrack: null` so a caller
can still tell a fallback from a real choice, and Amp logs the fallback at `info`.

### 4. The picker is a tab, and explicitly not a need

The record page gains a fifth tab, **A demo cut**, after a rule, with no `●`/`○` glyph and the
screen-reader text "optional".

`Need` and `RecordSection` stay separate types. A `Need` is something every record must have before
it goes on the shelf — the collection labels the first outstanding one, and `outstandingNeeds` is
what makes "any order" true by construction ([ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md)). Counting a demo cut would put a
permanent outstanding item on several hundred finished records, which is precisely the misreading
[ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md) was written about. So the demo cut is a section, never a need, and
`needs.test.ts` pins that boundary rather than the current membership.

Two consequences on the tags panel, which now shows three stickers:

- `TAGS VERIFIED` still marks **two**. Claiming a demo tag was written when you never made one would
  be a lie on the one screen whose job is catching mis-written stickers. The demo tag carries its own
  "I've written this one", posting the per-object `tag-written` that has existed since issue #55.
- Each sticker states **what it plays**. A demo tag with no cut chosen behaves exactly like the shelf
  card, and a panel that didn't say so would make the fallback in §3 look like a bug.

## Consequences

- **New shared surface**: `curator:demo:<id>`. The scan-event schema, `@marquee/contracts`, Stylus's
  `URI_RE` and the Flipper app all learn it. Conductor and Backdrop learn it for free, and now have
  tests enumerating every kind rather than naming two.
- **New Curator surface**: `GET /api/albums/:id/tracks`, `PUT /api/albums/:id/demo-track`,
  `?object=demo` on the two existing tag routes, and `demo` accepted by `tag-written`.
- **A latent Sonos bug surfaced and was fixed.** `patchContainerUri` replaced the library's hardcoded
  `sid`/`sn` by matching `[?&]` — but `@svrooij/sonos` serialises a **track** URI with `&amp;`
  separators (`?sid=9&amp;flags=8224&amp;sn=7`), so `sn=7` survived. On a live account that is a UPnP 800. It could not have been hit before this ADR, because Amp only ever handed Sonos album
  containers; the demo track is the first URI of that shape. Now covered by a test that went red
  first.
- **A record with no demo cut is unchanged in every way.** No migration: `demoTrack` absent is the
  default, and the demo tag is one most records will never get.
- **Deferred.** Previewing the cut from Curator (you judge it by hearing it in the room, and the room
  already has audio); a per-track demo tag for albums with several worth showing off (one tag, one
  song, one choice); anything that picks the cut for you — the whole point is that no derivation gets
  it right.
- **Naming collision, accepted knowingly.** Curator already has a "Demo Room" (`/api/demo/*`,
  `src/demo/`) — the rehearsal preview. "Demo" now names two unrelated things in this repo. The
  maintainer chose the word deliberately over `cut` and `single`; nothing is shared between them, and
  the demo tag's code lives under `tags/` and `demoTrack`, never under `demo/`. Recorded here so the
  next reader knows it was a decision rather than an oversight.
