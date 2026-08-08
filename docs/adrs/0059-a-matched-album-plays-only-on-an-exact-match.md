# ADR 0059 — A matched album lends its cover on a close match and plays only on an exact one

Status: accepted · Date: 2026-08-08 · Amends:
[ADR 0017](0017-discogs-personal-token-and-direct-images.md) (the Discogs→Spotify matcher now serves
two purposes at two bars, not one), [curator-spec.md](../specs/curator-spec.md) (§7 metadata,
§8 a new library job), [amp-spec.md](../specs/amp-spec.md) (why a card scan was silent for most of a
Discogs library) · Relates: [ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) (the demo tag,
which surfaced this), [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) (card scans),
[ADR 0029](0029-batch-work-runs-as-a-library-job.md) (the sweep's shape)

## Context

[ADR 0017](0017-discogs-personal-token-and-direct-images.md) added a fuzzy matcher so a Discogs add
could borrow Spotify's cover art. It is deliberately conservative — artist **and** title must both
match closely — because a wrong match means the wrong sleeve.

`resolveSpotifyArtUrl` then did this:

```ts
return bestSpotifyMatch(q, candidates)?.artUrl;
```

`bestSpotifyMatch` returns a whole `SpotifyAlbumMeta`, **including `spotifyUri`**. That line kept the
cover and discarded the identity.

On the maintainer's own library the cost was concrete: **481 of 499 records are Discogs-sourced with
no `spotifyUri`, and 393 of them carry a Spotify-resolved `spotifyArtUrl`** — proof that Curator had
identified the album, used its artwork, and forgotten which album it was.

`metadata.spotifyUri` is the single field every audio consumer reads:

- **Amp** on a `card` scan (ADR 0034) and a `demo` scan (ADR 0058) — absent → `202 ignored,
"album not on spotify"` → **silence**;
- bench-preview desk audio (ADR 0037);
- the room rehearsal's audio leg (ADR 0028);
- the demo-cut picker's tracklist (ADR 0058).

So ADR 0034's headline feature — drop a shelf card, the album streams — has been inert for ~96% of a
real collection since the Discogs sweep landed, and nothing reported it, because every one of those
consumers was correctly reporting what the asset said.

This was found by building the demo tag on `spotifyUri` and watching it say "This record isn't on
Spotify" about a record that plainly is.

## Decision

**Keep the matched album's identity — but only let an `exact` match name an album for playback.**

### 1. One matcher, two bars

`bestSpotifyMatch` now returns `{ album, confidence }`:

- **`exact`** — artist and title agree outright once normalized, and the years don't disagree by more
  than one (a reissue legitimately differs; a decade apart means a different release). The only
  verdict allowed to set `spotifyUri`.
- **`close`** — qualifies under `closeMatch`'s ≥60%-substring rule, or the years are far apart. Sets
  `spotifyArtUrl` and nothing else.

**The asymmetry is the whole decision.** ADR 0017 picked its threshold for covers, where a wrong
match is embarrassing and instantly obvious to the person looking at it. Reusing that same verdict to
choose _what audio plays_ silently promotes it to a much higher-stakes claim: a bad match starts the
wrong record in a room full of people, and nobody there knows why. Same evidence, different cost of
being wrong, therefore a different bar.

Rejected: **one bar, tightened for both.** It would drop covers Curator gets right today for no gain
— the art path has been fine for a year — and "make the cover matcher stricter" is a change nobody
asked for hiding inside a change about audio.

Rejected: **one bar, loosened for both** (just store whatever the art path matched). Fastest, and it
is what the obvious one-line fix does. It buys ~393 playable albums at the price of an unknown number
of rooms playing the wrong record, with no way to tell which.

### 2. Provenance is recorded, not just the result

`metadata.spotifyMatch = { confidence, name, artist, year?, matchedAt }` records what was matched and
how well, whenever a match happens at either bar.

`spotifyUri`'s presence keeps meaning exactly one thing — **trusted enough to play** — so Amp,
desk audio and the picker need no changes and no notion of confidence. The seam stays where it was.
But a guess that reaches the asset is now inspectable: a `close` match can say, in the UI, _what_ it
found and that it is deliberately not playing it.

Rejected: **store the URI always plus a confidence field, and gate at read time.** That pushes the
"is this good enough" question across a service boundary into Amp, Backdrop's siblings, and every
future consumer — four places to get it right instead of one, and a contract change for all of them.

### 3. A backfill, because fixing onboarding fixes nothing already on disk

`POST /api/albums/spotify-backfill` runs a library-scoped job (ADR 0029) re-matching every Discogs
album with no `spotifyUri`. It applies the identical rule through the shared `applySpotifyMatch` —
one definition of "good enough to play", used by both paths, because two would drift.

Three properties it must have, each with a test:

- **Never overwrite an existing `spotifyUri`.** One on disk is either a Spotify add or an earlier
  exact match; re-deriving could only replace a fact with a guess.
- **Never let `close` set one**, exactly as onboarding.
- **Give up after 10 consecutive failures**, reporting `abandoned`. Ten failures is not ten bad
  albums, it is a dead token or a rate limit, and discovering that at album 400 wastes minutes and
  several hundred requests. A short run that looks clean is worse than one that says it stopped.

### 4. The copy told a lie, and it is the reason this went unnoticed

"This record isn't on Spotify" was said about anything without a URI. For a Discogs pressing that is
usually false. It now distinguishes three genuinely different situations: a hand-added album (no
streaming identity at all), a `close` match (names what it found, and says it won't play from it),
and an unmatched one (says it hasn't been matched _yet_, and points at the backfill).

## Consequences

- **~393 records on the maintainer's library become playable** by a shelf card, a demo tag, and the
  demo-cut picker, after one backfill run. That is ADR 0034 finally working at collection scale.
- **Some matches will be `close` and stay silent.** That is the trade being bought deliberately: the
  UI names them so they can be resolved by hand, rather than guessing on the user's behalf.
- **`metadata.spotifyMatch` is new on the asset**, and absent on every album added before this. Its
  absence means "never matched", which is exactly right for pre-existing assets.
- **The `artUrl` candidate filter is inherited, not reconsidered.** `bestSpotifyMatch` still skips
  candidates with no cover, which is an art-shaped rule now also gating audio. Left alone: an album
  Spotify has no art for is thin enough that betting audio on it is not obviously better. Worth
  revisiting if it ever refuses a real record.
- **Not addressed: correcting a match by hand.** The UI can now _show_ a wrong or missing match but
  offers no way to paste the right Spotify URI. That is the natural follow-up, and until it exists
  the answer for a stubborn album is to add it from Spotify instead of Discogs.
