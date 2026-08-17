# ADR 0094 — Adding an album is a projection change

**Date:** 2026-08-16
**Status:** Accepted
**Supersedes:** nothing. Amends [ADR 0015](0015-backdrop-sync-triggered-at-projection-changes.md)
(the trigger list) and completes the amendment
[ADR 0073](0073-a-record-with-no-visualizer-plays-the-default.md) announced but did not make.

## Context

[ADR 0073](0073-a-record-with-no-visualizer-plays-the-default.md) made every album Curator holds
project as a Backdrop library entry — `usesDefault` until it has a visualizer of its own — so that a
tagged-but-unfinished record plays a shared default clip instead of nothing. Its header says it
amends ADR 0015 on "what counts as a projection change". The only amendment it actually made was
that a _detach_ rewrites an entry rather than deleting it.

The trigger list itself was left alone. [ADR 0015](0015-backdrop-sync-triggered-at-projection-changes.md)
fires on video attach, video detach, album delete, `verified`, and the manual full reconcile. That
list was complete when it was written, and for an exact reason: `buildLibraryEntry` returned `null`
for an album with no video, so a newly added album had nothing to project and pushing at creation
would have been a no-op at best.

ADR 0073 removed that reason and nothing widened the list. So between "album created" and "video
attached" — which for a collection midway through its visualizers is most of the shelf, and for a
freshly swept Discogs collection is all of it — Backdrop had never heard of the record.

Observed 2026-08-16. Two records went on the stand; the lights came up and the display stayed on
whatever was there before:

```
17:23:14  curator:album:g06sfn37  "scan for an album not in the library — staying put"
17:23:40  curator:album:34w923ac  "scan for an album not in the library — staying put"
17:24:18  curator:card:rpagsnv2   "record has no visualizer of its own — playing the default"
```

The third line is the control: the ADR 0073 fallback works. The first two never reached it. Curator
held 482 albums and Backdrop's `library.json` held 478 — the four missing ones added in one Discogs
sweep after the last manual reconcile.

The damage is not only the missing picture. `video not in library` is the mis-written-sticker
indicator that backdrop-spec §13 calls out by name and that ADR 0073's whole Context section is
about disambiguating. A creation path that never announces puts it straight back to meaning two
things.

## Decision

**Creating an album is a ★sync trigger, and the trigger is structural rather than a list.**

1. **`publishNewAlbum` is the one way an album comes into existence.** Every add path — manual,
   Spotify, Discogs, the pasted batch, the collection sweep — ended in the same three lines (save,
   enqueue with Roadie, return). That common tail becomes `albums/publish.ts`, which saves, enqueues,
   and _announces_, in that order: saved before announced so the announce describes something that is
   actually on disk.

2. **`announce` is a required field of `NewAlbumDeps`, not an optional one.** This is the part that
   matters. A trigger list is a fact about the system kept in a document, and it went stale silently
   because nothing forced ADR 0073's author to revisit it. A required dependency is the same fact
   kept in the type system: a new creation path cannot be written without a `deps`, and cannot build
   one without deciding what announcing means. The compiler asks the question the list stopped
   asking.

3. **Backdrop only, deliberately not Conductor.** Backdrop's projection is `{ uri, usesDefault }` and
   carries no metadata, so an entry pushed the moment the album exists is true from that moment and
   stays true until a video attaches — where ADR 0015's existing ★sync takes over. Conductor's
   projection is the whole asset, which at creation is a shell with no palette; announcing it there
   would publish a placeholder and owe a re-push at every step of Roadie's pipeline. ADR 0015 §3
   keeps the two legs independent precisely so that stays a separate question.

4. **Best-effort, like every other push** (roadie-spec §6, ADR 0015 §3). `announceToRuntime` in
   `server.ts` is the only place the announce is built and the only place that has to guarantee it
   never throws: by the time it runs the album is saved and queued, so failing the request would
   report "not added" for a record that was added, and the natural retry would make a duplicate.
   `syncMetadata` records its own failure as the album's `syncIssues`, so an unreachable Pi is
   visible in the UI rather than silent.

## Consequences

**Good.** A record is playable from the moment it exists, which is what ADR 0073 promised and what a
collection with a visualizer backlog actually needs. `video not in library` goes back to meaning only
what it says. The Discogs sweep — unattended, and the highest-volume creation path there is — carries
its own announce rather than depending on somebody running a reconcile afterwards.

**Bad.** Every add now costs one small HTTP round-trip to Backdrop, including each line of a pasted
batch and each row of a sweep. They are metadata-only pushes to a Pi on the LAN and they are
best-effort, but a 500-line paste against an unreachable Backdrop now spends a connection timeout per
line. If that becomes the thing that hurts, the fix is a batched announce, not a quieter one.

**Watch for.** The required `announce` is enforced by `tsc` over `src/`, and the Curator test suite
is not typechecked — a test that builds deps by hand gets `undefined` and fails at runtime instead,
which is noisier but later. `test/helpers.ts` exports `noAnnounce` and `spyAnnounce` so there is an
obvious right answer to reach for.

**Not decided here.** Whether Conductor should also hear about an album at creation. The lights
already work for an unfinished record, so there is no symptom driving it, and the answer depends on
whether Conductor should hold palette-less shells — which is a question about Conductor's directory,
not about this bug.
