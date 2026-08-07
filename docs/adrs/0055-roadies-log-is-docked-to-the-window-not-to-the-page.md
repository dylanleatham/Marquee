# ADR 0055 — Roadie's log is docked to the window, not to the page

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amends:** [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md), which introduced
  the log as a footer strip on the collection.

## Context

ADR 0052 put Roadie's log at the foot of the collection: the newest line always visible, the rest
behind a toggle. That reads correctly on a short collection, where the grid's `flex: 1` pushes the
strip to the bottom of the window anyway.

It stops being true the moment the collection is worth having. At any real size the grid is taller
than the window, so the strip sits at the bottom of the **document** — and you have to scroll past
every record you own to find out what Roadie is doing. The one piece of the screen that reports live,
changing state was the one piece you had to go looking for.

That inverts what the strip is for. Roadie's log is ambient: it earns its place by being glanceable
while you work the grid, not by being a section you navigate to.

## Decision

The strip and its panel move into a single `.roadiedock`, pinned to the bottom of the viewport with
`position: sticky; bottom: 0`.

**`sticky`, not `fixed`.** A fixed dock leaves the flow entirely, so the grid slides underneath it
and the last row is unreachable unless the page reserves a matching `padding-bottom`. That number
would have to equal the strip's rendered height — a constant duplicated away from the padding and
type that produce it, and silently wrong the first time either changes. Sticky keeps the dock in
flow: it pins while the collection is taller than the window, and simply sits at the end when it
isn't, which is exactly the old behaviour on a short collection. No reserved space, no magic number,
no regression for small collections.

It also matches what the app already does at the other edge: the masthead is `position: sticky;
top: 0; z-index: 20`. The dock is the same move at the bottom, at `z-index: 40` — above the masthead
layer, below the ready toast at `60`.

### The panel opens upward

The panel now **precedes** the strip in the DOM. From a dock at the bottom of the window, markup
order is the direction the panel opens; rendered after the strip, as it was, it would expand off the
bottom of the screen — present, correct, and unreadable. This is a real constraint rather than a
tidiness preference, so `RoadieLog.test.tsx` asserts the order rather than leaving it to be
rediscovered.

### The panel is bounded

`max-height: 45vh` with `overflow-y: auto`. The log accumulates for the life of the session, and in
flow that only ever made the page longer. From a pinned dock, an unbounded panel would grow to cover
the whole window — so the thing that reports what Roadie is doing would hide everything Roadie is
doing it to.

## Consequences

- The collection loses ~33px of vertical space to the strip at all times. That is the trade being
  made deliberately: the log is worth a permanent sliver, which is why it is a one-line strip and not
  a panel by default.
- The ready toast (`position: fixed; bottom: 26px; z-index: 60`) now floats over the strip's top edge
  by a few pixels rather than over the grid. It is above the dock in the stacking order, transient
  (5s), and shadowed, so it reads as layered over the strip rather than broken. Left alone
  deliberately: offsetting it would mean reintroducing the strip-height constant this decision exists
  to avoid, and applying it on every screen for a strip that only the collection has.
- `curator-ui-ux` §5 is updated in this PR: "a footer strip" was accurate and is no longer.
- Sticky depends on no ancestor between the dock and the scroll container having `overflow` other
  than `visible`. Today that chain is `.app` → `.app__body` → `.collection`, all clean. Adding an
  `overflow` there would break the pin **silently** — it would simply revert to the old behaviour,
  with no error and no failing test, since jsdom does not lay out sticky positioning. Verified in a
  real browser at the time of this change.
