# ADR 0073 — A record with no visualizer plays the default

**Date:** 2026-08-12
**Status:** Accepted
**Supersedes:** nothing. Amends [ADR 0015](0015-backdrop-sync-triggered-at-projection-changes.md)
(what counts as a projection change) and the §9/§10 degradation wording in
[backdrop-spec](../specs/backdrop-spec.md).

## Context

Curator's Backdrop projection returned `null` for an album with no visualizer attached, and `null`
meant "not in the library". A record therefore reached Backdrop only once it had a video; before
that, Backdrop had never heard of it.

That is fine right up until the record goes on the stand. Nothing in the system requires a visualizer
before a card or a tag — the three needs are deliberately independent
([ADR 0052](0052-a-record-is-what-it-still-needs.md), [ADR 0069](0069-the-lights-are-not-a-need.md)) —
so a record can be tagged, verified, and shelved with its visualizer still outstanding. Placing it on
the stand then lit the room (Conductor reads the asset store, which has the palette from the moment
Roadie pulls it) and left the display on whatever was there before, with a four-second `video not in
library` hint in the corner. Lights, no picture. For a collection midway through its visualizers that
is most of the shelf.

Worse, that hint was a lie by omission. `video not in library` is the indicator that catches a stray
NTAG or a sticker written with the wrong id — backdrop-spec §13 calls it out by name as the case that
"is going to happen more than you think". Because an unfinished record produced exactly the same
symptom, the indicator could no longer distinguish "this tag belongs to nothing" from "this record is
simply not done", which is the one distinction it exists to make.

## Decision

**A record Curator knows about, which has no visualizer of its own, plays a shared default clip. A
scan of something Curator does not know about still plays nothing and still says so.**

Three parts:

1. **The projection names every record.** `buildLibraryEntry` no longer returns `null`; an album with
   no `visualizer` projects as `{ uri, usesDefault: true }`. `LibraryEntry.filePath` becomes optional
   and `usesDefault` becomes the marker for the second shape. Removal is now reserved for the album
   ceasing to exist (delete, merge) — a detach _rewrites_ the entry rather than deleting it.
2. **Backdrop resolves the fallback.** `[storage].default_visualizer` (env
   `BACKDROP_DEFAULT_VISUALIZER`, default `default.mp4`) names one clip inside `media_dir`. A
   `usesDefault` entry plays it. So does an entry whose own file is absent or outside `media_dir` —
   the room going dead is not a better answer to a failed sync than a stand-in.
3. **The distinction stays visible.** An _absent_ entry keeps its old behaviour verbatim: stay put,
   flash `video not in library`. `GET /api/status` gains `usingDefault`, and `GET /api/library`
   judges a `usesDefault` entry's `fileMissing` against the default clip, so "this record is playing
   a stand-in" is answerable without standing in front of the TV.

The marker is what makes (3) possible. Backdrop could have fallen back on any unresolvable scan and
needed no contract change at all — and would have thrown away the mis-written-sticker indicator to do
it. Curator naming its own records is the cheaper half of that trade.

`PUT /api/media/:fileId` additionally accepts the literal `default`, landing the clip at
`{media_dir}/default.mp4`. A literal alternative in the pattern, not a widened character class: one
extra reachable filename, no traversal surface. Without it the only route onto a Pi is an out-of-band
`rsync` — the silent gap [ADR 0038](0038-curator-pushes-media-over-http.md) removed for real
visualizers, and worse here, because one missing file takes out every unfinished record at once.

## Consequences

**Good.** A tagged record always does something. The shelf becomes usable long before the visualizer
backlog is cleared, which is the actual state of the collection and will be for a while. The
not-in-library indicator goes back to meaning what it says. A failed media transfer degrades to a
stand-in rather than to a dead display, while `/api/status` and `/api/library` still report the truth.

**Bad.** Backdrop's library is now the whole collection rather than the videoed part of it, so a
`sync` pushes more entries — metadata only, tens of records, no bytes. And a default clip that
nobody notices is a default clip nobody replaces: the fallback makes an unfinished record _less_
visibly unfinished on the display. That pressure is deliberately kept in Curator, where
`NEEDS VISUALIZER` is unchanged — playing a stand-in does not satisfy the need, and no code reads the
fallback as progress.

**Watch for.** The clip is one file, so it is one thing to forget. A Backdrop configured for a
default that never reached the Pi degrades to the old stay-put behaviour and says `no visualizer yet`
rather than `video not in library` — a distinct string precisely so the two are not confused when
diagnosing from the sofa. `GET /api/library` reports every `usesDefault` entry as `fileMissing` in
that state, which is the machine-readable version of the same fact.

**Not decided here.** One clip for every record, chosen by nothing. A pool, or a clip picked by the
album's palette, would both need Backdrop to see data it is deliberately not given
(runtime-overview §5: Backdrop reads `library.json`, not the asset store). If the single clip wears
thin, that is the next ADR, not a quiet extension of this one.
