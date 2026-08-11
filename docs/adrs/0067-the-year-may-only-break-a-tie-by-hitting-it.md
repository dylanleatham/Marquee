# ADR 0067 — Among an artist's same-titled albums, the year may only break the tie by hitting it

Status: accepted · Date: 2026-08-10 · Amends the ranking rule in
[ADR 0060](0060-the-year-is-a-tiebreak-not-a-gate.md) (the gating decision stands) · Amends
[curator-spec.md](../specs/curator-spec.md) (§7 metadata) ·
Relates: [ADR 0017](0017-discogs-personal-token-and-direct-images.md) (the matcher),
[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) (the two bars) ·
Closes [#288](https://github.com/dylanleatham/Marquee/issues/288)

## Context

The maintainer's copy of Weezer's **Blue Album** was wearing the **Teal Album**'s sleeve.

The Discogs side was right. Release [15980871](https://www.discogs.com/release/15980871) is a 2020
repress of the 1994 record, its Discogs image is the blue sleeve, and `metadata.year` was `2020`
because that is when the vinyl was pressed. The matcher was then asked for
`{ artist: "Weezer", title: "Weezer", year: 2020 }`.

Weezer have **six** albums called `Weezer` — Blue (1994), Green (2001), Red (2008), White (2016),
Teal (2019), Black (2019). Every one is exact on artist and title, so all six scored 4 and the year
tiebreak decided the whole question:

| candidate | year | gap to 2020 | score |
| --------- | ---- | ----------- | ----- |
| Teal      | 2019 | 1           | **5** |
| Black     | 2019 | 1           | **5** |
| White     | 2016 | 4           | 4     |
| Blue      | 1994 | 26          | 4     |

Teal won. Because artist and title _did_ agree, the verdict was `exact`, so `applySpotifyMatch`
wrote **both** the art URL and the `spotifyUri` — the cover became teal, the palette became teal
(`#1CBCBB`), and a tag for the Blue Album would have played the Teal Album. Precisely the failure
[ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) built the two bars to prevent,
arriving through the one signal 0059 never guarded.

### The tiebreak was reasoning from the wrong premise

[ADR 0060](0060-the-year-is-a-tiebreak-not-a-gate.md) kept the year as a ranking signal on this
justification:

> Among several albums of the same name by the same artist, the one nearest the pressing's year
> still scores highest and wins, so the metadata borrowed is from the right edition.

That is sound when the same-named candidates are **editions of one record** — an original and its
remaster. It inverts when they are **different records that share a name**, and the inversion is
worst on the case ADR 0060 itself established as the ordinary one for a vinyl collection: a repress.
0060 proved that a wide year gap usually means "you own a reissue" — which is exactly why the year
cannot then be used to _choose_ between distinct albums. A repress's year is a fact about a piece of
vinyl. Ranking by nearness to it selects whichever unrelated album happened to come out near the
repress date; here, a record released twenty-five years after the one on the shelf.

ADR 0060 did foresee a version of this and accepted it, listing "a re-recording, or a live album
sharing a studio album's name" and calling the result "the wrong edition of the right record by the
right artist" — mild, and correctable on the record page. This is the sharper version it did not
price in: not an edition, a **wholly different album**, chosen silently, with playback attached.

A second, smaller defect sat underneath: ties were resolved by candidate order (`score > best.score`
keeps the first seen), so even Teal-versus-Black was arbitrary rather than considered.

## Decision

**A candidate's _namesakes_ are the other qualifying candidates with the same artist and the same
raw title, differing in year. When the winner has any namesake, the match stands only if the query's
year lands on it exactly. Otherwise there is no match.**

Three things this deliberately does not do:

- **It does not gate anything ADR 0060 ungated.** A record with no namesake — the overwhelming
  majority, including every reissue in 0060's evidence — still matches however far apart the years
  are. The 160 records 0060 made playable stay playable. This rule only fires where the function is
  choosing _between_ same-titled albums, which is where it was guessing.
- **It keys on the _raw_ title, not the edition-stripped one.** `stripEditions` exists so
  "Purple Rain" finds "Purple Rain (Deluxe)"; those are one record in two dresses, ranking between
  them is meaningful, and either choice puts the right sleeve on the shelf. Keying the guard on the
  stripped title would make every album with a deluxe edition ambiguous and re-open 0060's
  mass-refusal problem. The raw title is what separates the deluxe case from the Weezer case.
- **It does not invent a new confidence.** `null` already means "keep the Discogs image", and for
  this bug that is not a consolation prize — the Discogs image is the _correct_ blue sleeve, taken
  from the release the user actually owns. Refusing lands on the right answer.

**Rejected: refuse whenever two or more candidates tie at the top score.** It fixes the reported
case only by accident (Teal and Black both being 2019), and would still hand the Blue Album a teal
sleeve if Spotify returned Teal but not Black. It measures a coincidence of the result set rather
than the ambiguity itself.

**Rejected: disambiguate on the Discogs tracklist.** Decisive — it is the one signal that actually
separates these six records — and much larger: a network fetch per candidate, a new comparison, and
a new failure mode, in a function whose whole value is being pure and string-only. Worth revisiting
if refusals turn out to be common; the cheap rule ships first.

## Consequences

- **A handful of records stop matching.** Self-titled albums by prolific artists, and reused titles
  within a discography. They keep their Discogs cover, which is the one that came off the pressing
  in your hands, and the record page's Spotify-URI input names the right album in one step when you
  want playback.
- **The residual case is same artist, same title, _same year_.** Teal and Black are both 2019, so if
  you own a 2019 pressing the year lands on both and one is still chosen arbitrarily. Left open on
  purpose: the fix for it is to treat same-year namesakes as ambiguous too, which would also refuse
  Spotify's genuine cross-market duplicates (the search sends no `market`, so the same album can
  appear twice). Refusing real matches to catch a two-album coincidence is the wrong trade today.
- **"Not matched yet" now covers a case the backfill can never resolve.** `unmatchedReason` tells
  you to run the Spotify backfill; for an ambiguous record the sweep will decline again, forever.
  That message is the honest-reporting concern ADR 0059 §"the reason distinguishes" was written
  about, and it needs its own state to say "several albums share this name — pick one". Filed as
  [#289](https://github.com/dylanleatham/Marquee/issues/289) rather than widened into this fix.
- **The blind spot is closed at both surfaces.** The onboarding step and the unattended backfill
  share `bestSpotifyMatch`, and both now have a regression test; the sweep's matters more, because
  a wrong identity written by a library-wide sweep is one nobody watched being written.
