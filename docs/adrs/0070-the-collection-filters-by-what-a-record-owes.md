# ADR 0070 — The collection has one chip per state, and a need filter asks what a record owes

Status: accepted · Date: 2026-08-10 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§4 the collection — the filter bar),
[curator-spec.md](../specs/curator-spec.md) (§ scope — "the queue survives as a filter chip"),
[design_handoff_curator_overhaul/README.md](../design_handoff_curator_overhaul/README.md) (the filter
bar and the grouped mode) ·
Builds on [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (the collection, and the
three chips this widens) ·
Relates: [ADR 0069](0069-the-lights-are-not-a-need.md) (the needs this filters over),
[ADR 0054](0054-not-complete-is-a-folded-corner-not-a-dimmed-sleeve.md) (how a not-complete sleeve
reads)

## Context

The collection had three chips: EVERYTHING, NOT COMPLETE · n, READY · n. Picking NOT COMPLETE
regrouped the grid under one heading per need, which is a good way to _see_ the shape of the
outstanding work and a poor way to _do_ it — you cannot narrow to one kind of task, and the records
Roadie is holding are reachable only through EVERYTHING.

The request was to filter by NEEDS CARD, NEEDS VISUALIZER "and all other categories for album state".
That is a different intent from browsing: it is sitting down to make cards for an hour. Two questions
had to be answered together.

**1. What does a need chip mean?** A tile shows only its _first_ outstanding need — never a count,
never "+1" ([ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md)) — and `groupByNeed`
follows the same rule so a sleeve appears once. Carrying first-need semantics into a chip would mean
NEEDS CARD showed only records where a card is the first thing missing.

**2. Which states get a chip?** `RecordState` has four kinds — `needs`, `ready`, `roadie`, `stuck` —
and only the first two were reachable.

## Decision

### 1. A need chip asks "does this record still owe one?", not "is it first?"

First-need semantics were rejected. The needs are **independent predicates** and the entire claim of
[ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) is that they may be done in any
order; a chip that hides a record wanting a card behind the visualizer it also wants contradicts that
in the one place it matters most. Concretely it fails the task it exists for: you clear NEEDS CARD,
and it refills from records that were owing a card the whole time. The chip never empties in one
pass, and the number on it never meant "how much of this work is left".

So a record appears under **every** need it still owes. The costs are real and accepted:

- **The per-need chips sum to more than NOT COMPLETE.** A record missing a visualizer and a card is
  counted in both. `CollectionCounts` therefore carries two maps: `byOutstanding` (what the chips
  say) and `byNeed` (first-need, what the groups hold).
- **The grouped view stays first-need**, so working down NOT COMPLETE still shows each sleeve once.
  The two views answer different questions and are allowed to disagree about the count.
- **The one-line detail under NOT COMPLETE reads `byNeed`**, not `byOutstanding` — a detail line
  claiming more records than the total directly above it reads as a bug.

A tile matched by a need chip is **relabelled to that need**. Under NEEDS CARD, a tile reading NEEDS
VISUALIZER looks like the filter leaked. This is the one exception to "a tile shows its first
outstanding need", and it is narrow: you asked about cards, so the tile answers about cards. Under
every other filter the tile keeps its own label.

### 2. One chip per state, named for the state

`CollectionFilter = "all" | RecordState["kind"] | Need` — the state chips are the `RecordState` kinds
spelled exactly, not a parallel vocabulary to keep in step. `visibleTiles` leans on that directly
(`t.state.kind === filter`) and a test pins it, so a fifth state cannot be added without the chip row
gaining one too.

The bar reads: EVERYTHING · NOT COMPLETE · NEEDS VISUALIZER · NEEDS CARD · NEEDS SIGN-OFF · READY ·
NOT STARTED · STUCK — broad to specific, then the states you cannot act on.

- **NOT STARTED and STUCK get chips** because no work filter includes them: neither "not complete"
  nor "ready" is true of a record Roadie is holding, and a card cannot be made for a record that
  failed to download. Without a chip they were reachable only through EVERYTHING.
- **STUCK renders as rows, not tiles**, wherever it appears — the same sentence-and-a-way-out row
  that already sits under the groups. A failure is not a missing artifact and does not read as one.
- **STUCK is dropped from the bar entirely when nothing is stuck.** The other chips are the standing
  vocabulary of the collection and read fine at zero; a permanent STUCK · 0 offers a category of
  failure to a collection that has none. This is the same rule that drops empty groups.
- **EVERYTHING carries no count** — the search placeholder already says how many records there are.

### 3. The filter still lives in the URL, and is parsed totally

`?filter=` round-trips as before, defaults written as absence of the param, updates with
`{ replace: true }`. `parseFilter` is **total**: anything unrecognised lands on `all`. A hand-edited
`?filter=banana` must not produce a blank wall with no chip pressed — the same lesson `?density=`
already learned, and it now also catches `?filter=lights`, which was a valid value until
[ADR 0069](0069-the-lights-are-not-a-need.md).

### 4. The filter bar wraps

Eight chips no longer fit beside the search on a 1280 window — measured, the chips themselves end at
1191px, so it is the 320px tools block that does not fit, and the wrap drops **the tools** to their
own row while the chips stay on one line. `.filterbar` gains `flex-wrap`, and the
chips carry their own bottom rule so a wrapped second row still reads as ruled paper — on a single
row it lands exactly on the bar's own border and is invisible. `.filterbar__tools` moves from
`flex: 1; min-width: 0` to `flex: 1 0 auto` with a real min-width, because the former let the search
input shrink towards nothing rather than ever dropping to its own line.

## Consequences

- The chip count and the size of the grid it opens are two derivations of one fact.
  `collection.test.ts` pins them together for all three needs, which is the assertion that would
  catch a future divergence between `byOutstanding` and `visibleTiles`.
- The empty state now has three voices, not two: an empty collection, a search that matched nothing,
  and a chip that is genuinely clear. "Try a different name, or clear the search" is useless advice
  when you never typed one — an empty NEEDS CARD means you have finished the cards.
- STUCK · n appears twice on screen when NOT COMPLETE is selected — once as a chip, once as the row
  heading. This is the pattern NOT COMPLETE already set with the stat band, and is left alone.
- The state chips being the `RecordState` kinds verbatim is load-bearing and cheap; the alternative
  was a lookup table that could rot silently.

## What this does not change

The shuffle, the density cycler, the search, the fold on a not-complete sleeve
([ADR 0054](0054-not-complete-is-a-folded-corner-not-a-dimmed-sleeve.md)), or the grouped view's
first-need grouping. NOT COMPLETE behaves exactly as it did.
