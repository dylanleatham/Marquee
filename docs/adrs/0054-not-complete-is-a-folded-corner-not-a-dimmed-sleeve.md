# ADR 0054 — "Not complete" is a folded corner, not a dimmed sleeve

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amends:** [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md), which introduced the
  collection grid and its three-way not-complete treatment.

## Context

The collection marks a record that isn't finished **three ways at once**, so that no one signal is
load-bearing and none of them is colour — the rule in
[curator-ui-ux §3.4](../specs/curator-ui-ux.md), written down because Backdrop had already shipped a
connection indicator that was unreadable without colour vision (PR #85).

The three were: a paler outline, **reduced contrast on the artwork** (`opacity: 0.62`), and the need
spelled out in words underneath.

The middle one was wrong on its own terms. The collection is art-first — a wall of sleeves you browse
rather than a list you work down, which is the whole premise of ADR 0052. Dimming the sleeve degrades
the one thing the screen exists to show, and it degrades it for **most of the wall**: on a collection
mid-build, "not complete" is the common case, not the exception. The signal was fighting the screen's
purpose, and it was doing so at the moment the screen is least useful anyway (early, when few records
are finished).

It is also the weakest of the three at a glance. Opacity reads as "washed out" only in comparison to
a neighbour at full strength; a screenful of not-complete records has nothing to compare against and
just looks like a low-contrast grid.

## Decision

Replace the wash with a **turned-down corner** on the sleeve — a paper-coloured triangle with an ink
rule along the diagonal, drawn in the bottom-right of the artwork, inside the outline.

The three signals remain three: paler outline, folded corner, the word underneath. Only the middle
one changes.

- **It is a shape**, so it satisfies §3.4 without help from hue — which matters concretely here,
  since this project's own user is colour-blind.
- **It costs the artwork nothing.** The sleeve renders at full contrast; the fold occupies 22px of
  one corner.
- **It reads as an absolute, not a comparison.** A folded corner is legible on a screen where every
  record is folded, which is exactly the state a collection spends most of its life in.
- **It is the existing paper metaphor**, not a new vocabulary: the grid is already ruled paper with
  square corners and no shadows, and a dog-eared page is what that idiom does for "unfinished".

The fold sits **inside** the outline rather than clipping it, so the frame stays a closed square. A
`clip-path` notch would have cut the outline too — CSS clips an element's outline along with its box
— leaving two unstroked raw edges that read as a rendering bug rather than as a mark.

### Where it lives

The fold is a `::after` on a new `.tile__sleeve` wrapper, not on `.tile__art` itself. `.tile__art` is
an `<img>` when there is cover art and a `<div>` when there is only the palette stripe, and **an
image can carry no pseudo-element**. A treatment applied directly to `.tile__art` would therefore
have appeared on un-fetched sleeves only — silently correct in the tests that use the stripe, and
absent in production for exactly the records that have their artwork. The wrapper is rendered for
every state so the DOM has one shape; only the modifier class varies.

## Consequences

- `curator-ui-ux` §3.1 and §3.4 are updated in this PR to name the fold instead of the wash.
- The grid gains one wrapper element per tile. It sets no box of its own (`display: block;
position: relative`) — the art still determines the size — so no layout changes.
- The fold is a pseudo-element and so is invisible to a screen reader. This is correct and unchanged
  from the wash it replaces: the accessible signal has always been the word underneath, which is real
  text in the markup. What a test can assert is the modifier class, and that is what
  `Collection.test.tsx` asserts.
- Nothing about `recordState` or the need model moves. This is a presentation change only; the
  "one need, never a count" decision in `needs.ts` is untouched, which is why a progress meter
  (`▪▪▫▫`) was rejected as the replacement despite being the more legible mark — it would have
  reopened a decision settled with the user over three rounds of review.
