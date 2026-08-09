# ADR 0064 — The sweep reports a record it already owns instead of adding it again

**Status:** accepted · 2026-08-09 · closes
[#279](https://github.com/dylanleatham/Marquee/issues/279)

## Context

[ADR 0051](0051-the-discogs-collection-is-swept-not-clicked.md) made the Discogs collection sweep
idempotent by deduping on the **Discogs release id**, which
[ADR 0017](0017-discogs-personal-token-and-direct-images.md) had established as the stable identity.
That is correct for what it covers, and it is what makes the sweep resumable, cursor-free and safe to
re-run.

It cannot cover a record the library holds **without** a release id.

The first full sweep, on 2026-08-07 at 14:48, re-added 15 albums that had been added from Spotify
between 27 and 30 July. A Spotify add carries no Discogs release id, so there was nothing for the
index to match on and every one of them fell through as a new record. The evidence is unambiguous:
the Spotify copy is the older one 15 times out of 15, and all 21 Discogs copies of duplicates share
that single timestamp.

The damage is not the count. It is that the two copies then **diverge silently**: the copy holding
the visualizer advances to `awaiting_tag_write` while the bare one sits at `awaiting_review`, which
is indistinguishable from a record you simply have not finished. Write a sleeve tag against the wrong
one and the stand does nothing, with no indication that a same-named sibling holds the video.

Three further pairs came from a different gap in the same sweep: two release ids for one title
(reissues or pressings), each passing release-id dedupe honestly, both added in a single run.

## Decision

When the sweep meets a release whose **record** the library already holds, it **adds nothing, changes
nothing, and reports a `collision`** — a status distinct from `duplicate`, surfaced in the sync
summary and counted separately.

- The match is on normalised title + artist, applied **only when the release id is unknown**. The id
  stays the authoritative check, so a re-run of an unchanged collection still reads as `duplicate`.
- Normalisation is lower-case and collapsed whitespace, nothing more. It found all eighteen real
  duplicates in the live library, and every step past it trades a false negative for a false
  positive.
- The index is also updated as the sweep adds, so two pressings inside one run collide too.

**The sweep does not merge, and does not choose.** Owning two pressings of one title is a real thing
in a record collection, and the app cannot tell that apart from an accident. Collapsing them would
destroy information the owner deliberately has.

## Consequences

- The mess stops growing. Nothing is created that a human then has to unpick.
- A collision is **visible**: it reaches the sync summary, not just a row. The first sweep reported
  its 15 as ordinary adds, which is precisely why they went unnoticed for a day.
- **A legitimate second pressing is now harder to add.** The sweep will decline it and report it, and
  adding it deliberately is a separate action. That is the accepted cost of not guessing — a missed
  add is recoverable, a wrong merge is not.
- The 18 duplicates already in the library are untouched by this. They need a separate, owner-driven
  merge, and that merge must transplant the Discogs identity onto the surviving copy rather than
  simply deleting the twin: delete the copy holding the release id and the next sweep, seeing no id
  to match, adds it straight back.
- ADR 0051's "dedupe is on the release id" remains true of what it describes. This adds a second,
  narrower guard beside it; it does not replace it.
