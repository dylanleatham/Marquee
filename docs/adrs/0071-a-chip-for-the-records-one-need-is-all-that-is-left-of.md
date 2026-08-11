# ADR 0071 — A chip for the records one need is all that's left of, and empty chips leave the bar

Status: accepted · Date: 2026-08-11 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§4 the collection — the filter bar) ·
Extends [ADR 0070](0070-the-collection-filters-by-what-a-record-owes.md) (the need chips this adds a
counterpart to, and the drop-at-zero rule this widens beyond STUCK) ·
Relates: [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (needs as independent
predicates), [ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md) (the label rule the new
words follow), [ADR 0069](0069-the-lights-are-not-a-need.md) (the three needs this filters over)

## Context

Two complaints about the filter bar, on a real 478-record collection, and they turn out to have one
answer between them.

**NOT STARTED reads · 0 and always will, most days.** Roadie clears a record in ~130ms, so the queue
is drained except in the minute after an import. The chip is a permanent empty category.

**NEEDS SIGN-OFF reads · 477.** This is [ADR 0070](0070-the-collection-filters-by-what-a-record-owes.md)
working exactly as designed — a need chip asks what a record still _owes_, not what it owes first,
and almost nothing has been tagged yet. But it means clicking it opens essentially the whole
collection, which is no use for the task the chips exist for. The maintainer asked for the records
that have _everything but_ a tag. Measured, that is **35** records, hiding inside a chip that says 477.

The counts make the gap concrete:

|                                                      | visualizer | card | tags    |
| ---------------------------------------------------- | ---------- | ---- | ------- |
| owes it at all (`byOutstanding`, what the chip says) | 442        | 435  | **477** |
| it is all that's left (what was asked for)           | 0          | 0    | **35**  |

Note `byNeed.card` is 0: every record missing a card is also missing a visualizer, so 442 of the 477
are blocked behind visualiser work and only 35 are within reach of an afternoon.

## Decision

### 1. A `JUST NEEDS …` chip per need, asking what a record has left rather than what it owes

`CollectionFilter` gains an `OnlyNeed`, and `CollectionCounts` gains a `byOnly` map. A record matches
`only-tags` when `outstandingNeeds` returns exactly `["tags"]`.

```ts
export type OnlyNeed = `only-${Need}`;
export type CollectionFilter = "all" | StateFilter | Need | OnlyNeed;

byOnly: Record<Need, number>;
```

**This does not revisit ADR 0070 — it is the other question, asked alongside.** The plain need chip
is _the pile you could contribute to_; the `JUST` chip is _the pile you can finish_. Both are useful
and neither substitutes for the other, which is why this is a second chip rather than a change of
meaning to the first. ADR 0070's argument against first-need semantics still holds in full: had
NEEDS SIGN-OFF been narrowed to these 35, the chip would refill from the 442 as visualizers landed,
and its number would never have meant "how much of this work is left".

The filter is spelled as a prefixed need rather than three literals so it cannot drift from
`NEED_ORDER` — a fourth need gets its filter, chip and count for free. It is resolved through a
lookup map, not a string slice, so `parseFilter`'s totality is not quietly undone by `only-banana`
slicing into a `Need`-shaped value nothing validates.

**No relabelling is needed**, unlike a plain need chip. When a need is the only one outstanding it
is also the first, so the tile's own label already reads as the chip does.

A corollary worth recording because it explains why this data was already on screen: **`byOnly` and
`byNeed` coincide for whichever need is last in `NEED_ORDER`** — nothing can outrank it, so being
first there is being alone. The grouped view under NOT COMPLETE therefore already contained exactly
the JUST NEEDS SIGN-OFF pile. It simply could not be reached as a chip, and its count was not
surfaced anywhere.

### 2. Empty chips leave the bar — widened from STUCK to every transient chip

[ADR 0070](0070-the-collection-filters-by-what-a-record-owes.md) dropped STUCK at zero and kept
everything else, reasoning that the rest were "the standing vocabulary of the collection and read
fine at zero". NOT STARTED · 0 is the counterexample. The line the rule actually wants is not
standing-vs-new but **a question you always ask of a collection** versus **a condition that happens
to be passing through**:

- **Stay at zero** — NOT COMPLETE, READY, and the three plain need chips. READY · 0 is information.
- **Dropped at zero** — STUCK, NOT STARTED, and each `JUST NEEDS …`. A permanent STUCK · 0 offers a
  category of failure to a collection that has none; NOT STARTED · 0 is a queue that is simply
  drained; JUST NEEDS CARD · 0 invites you into an empty room.

**Dropped, not deleted.** NOT STARTED returns the moment Roadie is holding something. Removing it
outright was considered and rejected: no work filter matches a record mid-process, so it would again
be reachable only through EVERYTHING — the precise hole ADR 0070 opened the chip to close. A test
pins the return.

## Consequences

- On the maintainer's collection the bar loses NOT STARTED, gains `JUST NEEDS SIGN-OFF · 35`, and so
  stays at eight chips. It is not always eight: worst case is eleven, and the bar already wraps
  ([ADR 0070](0070-the-collection-filters-by-what-a-record-owes.md) §4). In practice the drop-at-zero
  rule keeps it near eight, because the `JUST` chips are mutually exhausting — clearing the
  visualizers is what makes JUST NEEDS CARD appear.
- **`byOnly` sums to at most `notComplete`**, where `byOutstanding` deliberately exceeds it. A record
  with one need left is counted once; a record with two is counted nowhere. A test asserts the bound,
  since a `byOnly` that outran NOT COMPLETE would mean the predicate had drifted.
- The chip count and the size of the grid it opens stay two derivations of one fact, now pinned for
  `byOnly` as they already were for `byOutstanding`.
- A `?filter=only-card` bookmark still resolves when the chip is dropped at zero, and lands on an
  honest empty grid rather than silently widening to the whole collection. Pinned by a test, because
  "the chip is gone" and "the filter is invalid" are easy to conflate.
- `Collection.tsx` is untouched. The chip row already renders whatever `filterChips` returns, and
  `grouped` keys off `filter === "needs"` alone, so a `JUST` chip draws a flat grid without asking.

## What this does not change

The meaning of a plain need chip, the grouped view's first-need grouping, the shuffle, the search,
the density cycler, or the stuck row. NOT COMPLETE behaves exactly as it did.
