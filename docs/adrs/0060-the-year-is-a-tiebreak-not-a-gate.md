# ADR 0060 — The year ranks candidates; it does not decide whether an album may play

Status: accepted · Date: 2026-08-08 · Supersedes the confidence rule in
[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) §1 (the rest of 0059 stands: two
bars, provenance recorded, gating at write time) · Amends
[curator-spec.md](../specs/curator-spec.md) (§7 metadata) ·
Relates: [ADR 0017](0017-discogs-personal-token-and-direct-images.md) (the matcher)

## Context

[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) made `exact` require artist, title
**and** year agreement (within one year), reasoning that "a decade apart means a different release".
That was written from the armchair. Run against the maintainer's real 499-record collection, it
refused more than it accepted:

| outcome                     | count   |
| --------------------------- | ------- |
| `exact` — playable          | 177     |
| `close` — refused           | **213** |
| no match                    | 91      |
| skipped (already had a URI) | 18      |

Categorising the 213 is what settles it:

| why it was demoted                               | count   |
| ------------------------------------------------ | ------- |
| **year only** (artist and title agreed outright) | **163** |
| artist only                                      | 28      |
| several fields                                   | 17      |
| title only                                       | 5       |

And of those 163, **159 were the reissue direction** — the owned pressing _newer_ than Spotify's
release:

```
Radiohead — The Bends          mine 2016, Spotify 1995
Linkin Park — Meteora          mine 2021, Spotify 2003
The Prodigy — The Fat Of The Land   mine 2012, Spotify 1997
```

The year was not measuring what the rule assumed. **Discogs catalogues pressings; Spotify catalogues
releases.** For a vinyl collection a wide year gap is the _ordinary_ case — it means you own a
repress — and treating it as evidence against the match makes the rule strictest exactly where the
data is most reliable: the album whose artist and title agree perfectly.

A second, smaller cause inside the 28 artist-only demotions: Discogs disambiguates a duplicate artist
name with a trailing number (`Costanza (5)`), which is a database artifact rather than part of the
name.

## Decision

**`exact` is artist and title agreeing once normalized. The year no longer gates it.** Discogs's
`(n)` artist disambiguator is stripped before comparing.

The year keeps its other job: **ranking**. Among several albums of the same name by the same artist,
the one nearest the pressing's year still scores highest and wins, so the metadata borrowed is from
the right edition. It ranks; it does not refuse.

ADR 0059's structure is untouched and still doing the work: two bars, `close` lending only a cover,
provenance in `metadata.spotifyMatch`, and the gate at write time so nothing downstream needs a
notion of confidence. What changes is one predicate.

**What this gives up.** The year was guarding one real case: same artist, same title, genuinely
different record — a re-recording (`Taylor's Version`), or a live album sharing a studio album's
name. Those usually differ in title, and `stripEditions` can flatten that difference. So this rule
will occasionally name the wrong edition of the right record by the right artist. That is a much
milder failure than the one 0059 feared, and — decisively — it is now **correctable in one place**:
the record page shows what an album is matched to and lets you replace it
([#259](https://github.com/dylanleatham/Marquee/pull/259) built the input; this ADR's change makes it
visible whether or not a match exists).

That correctability is what makes the looser rule the right trade. 0059 chose strictness because a
wrong match was invisible and unfixable; neither is true now.

**Rejected: demote only when Spotify's release is _newer_ than the pressing.** This fits the data
exactly — 159 reissues one way, 4 the other — and would have refused only the four suspicious
anniversary editions. Rejected as too clever: it encodes a directional inference about pressing
chronology that will read as arbitrary in a year, to save four corrections that the UI now makes
trivial. Simple rule, visible result, easy fix.

## Consequences

- **Roughly 160 more records become playable** by a shelf card, a demo tag, and the demo-cut picker,
  after re-running the backfill. Combined with 0059's 177, most of the collection.
- **Some matches will be the wrong edition.** The record page names what was matched, so this is
  visible where you would notice it — a tracklist that isn't the one you own — and fixable there.
- **`close` now means one specific thing**: the substring rule matched but the strings are not equal.
  A narrower and more explicable category than before, when it also swept up every reissue.
- The four albums where Spotify's release is newer than the pressing (anniversary editions and the
  like) will now match and play. If that turns out to matter, the directional rule rejected above is
  the fix, and the evidence for it is in this ADR.
