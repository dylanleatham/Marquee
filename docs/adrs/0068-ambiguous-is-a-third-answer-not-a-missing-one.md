# ADR 0068 — "Several albums share this title" is a third answer, not a missing one

Status: accepted · Date: 2026-08-11 · Completes the consequence deferred by
[ADR 0067](0067-the-year-may-only-break-a-tie-by-hitting-it.md) · Extends
[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) (the reason distinguishes what it
knows) · Amends [curator-spec.md](../specs/curator-spec.md) (§7 metadata, the Spotify routes) and
[curator-ui-ux.md](../specs/curator-ui-ux.md) (the record page's Spotify control) ·
Closes [#289](https://github.com/dylanleatham/Marquee/issues/289)

## Context

[ADR 0067](0067-the-year-may-only-break-a-tie-by-hitting-it.md) taught the matcher to refuse an
artist's several same-titled albums rather than let a repress's year pick one. It shipped that
refusal as `null` — the same value the matcher already returned for "searched, found nothing" — and
listed the consequence as known and deferred:

> **"Not matched yet" now covers a case the backfill can never resolve.** `unmatchedReason` tells you
> to run the Spotify backfill; for an ambiguous record the sweep will decline again, forever.

That is worse than vague. It is a specific instruction that cannot work, offered at the exact moment
someone is looking for what to do — and running a library-wide sweep to fix one record is minutes of
Spotify calls that end in the same refusal. It is the same defect
[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) fixed when it split "we don't know"
from "it isn't there", a sentence that "sent this project's own user looking for a bug in the
picker". Ambiguity is a third thing again: **found, repeatedly, and only a human can settle it.**

## Decision

**`ambiguous` is a first-class outcome, carried from the matcher to the sentence on the screen.**

1. **The matcher returns an outcome, not a nullable match.** `matched | ambiguous | none`. The two
   refusals were never the same fact and collapsing them is what produced the wrong sentence.
   `ambiguous` carries the candidates, because they are the answer rather than debris.

2. **An error is never `ambiguous`.** Spotify being down resolves to `none`, which already means
   "look again later" — exactly right. `ambiguous` promises the opposite, that looking again will
   never help, so it is only ever a verdict on a search that came back.

3. **The asset records the count, never the catalogue.** `metadata.spotifyAmbiguous` holds
   `{ candidateCount, detectedAt }` and is mutually exclusive with `spotifyMatch`. The candidate
   list is a fact about Spotify, not about this record: it goes stale the moment an anniversary
   edition ships, and the store keeps choices rather than catalogues — the same rule that keeps a
   twelve-row tracklist off a git-tracked JSON file (`DemoTrack`, ADR 0058).

4. **The list is re-fetched on demand,** from `GET /api/albums/:curatorId/spotify-candidates`, which
   runs the matcher's own search through `bestSpotifyMatch` and returns the set it declined. The UI
   never decides which albums are indistinguishable — that rule lives in ADR 0067 and gets exactly
   one implementation.

5. **The sweep reports it separately** (`ambiguous`, not `no_match`) and the record page offers
   **CHOOSE THE RIGHT ALBUM** with the covers, and deliberately **no link to the library sweep**.

### The set it refuses on and the set it offers are different, on purpose

This is the part that will look like a bug to a future reader, so it is written down.

- **Refusing** turns on _namesakes_: same artist, same raw title, **different year**. ADR 0067
  deliberately treats a same-year twin as one of Spotify's cross-market duplicates (the search sends
  no `market`), because refusing on those would refuse real matches.
- **Offering** uses every same-titled candidate, twins included.

Weezer's Teal and Black albums are both 2019 and both called `Weezer` — the duplicate assumption is
wrong for exactly that pair. A picker built from the refusal set would silently omit the Black Album,
so whoever owns it could never choose it, which defeats the whole feature. Over-offering costs a
person one glance; under-offering costs them the only route out.

**Rejected: a `MatchConfidence` of `"ambiguous"`.** It reads as "a match we're unsure of", and
`spotifyMatch` means _this is which album it is_. There is no album here. A separate field makes the
mutual exclusion structural instead of conventional.

**Rejected: storing the candidates on the asset.** It would let the picker render with no network,
and it is wrong for the same reason ADR 0058 gave for tracklists — plus it would go stale silently,
which is the failure mode this whole thread of ADRs exists to avoid.

## Consequences

- **The dead end becomes the shortest path.** The one screen that can settle an ambiguous record now
  says so and offers the answers, sleeve-first — six rows reading "Weezer (2019)" are told apart by
  their covers far faster than by their years.
- **The sweep's summary gains a category that means "your turn"**, shown only when the count is
  non-zero, so a library with no same-titled albums never carries a standing "0 need you" chore.
- **`spotifyAmbiguous` is derived state and may be stale in one direction**: an album that becomes
  unambiguous (Spotify merges a duplicate) keeps the marker until something re-matches it. Harmless
  — the picker re-asks live and will offer the single album — but it is why the marker is cleared on
  any successful match rather than trusted as a permanent verdict.
- **The residual from ADR 0067 is unchanged**: same artist, same title, same year is still resolved
  arbitrarily _when a match is made_. This ADR makes it visible rather than fixing it — both twins
  now appear in the picker, so the human can correct what the matcher guessed.
