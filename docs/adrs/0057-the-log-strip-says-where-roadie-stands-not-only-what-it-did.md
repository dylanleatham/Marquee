# ADR 0057 — The log strip says where Roadie stands, not only what it did

- **Status:** Accepted
- **Date:** 2026-08-08
- **Follows:** [ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md), which fixed the label
  that sent us looking for a stalled Roadie. This fixes the reason we could not tell.

## Context

Roadie's log strip reported history: the newest transition, as a sentence, with a pulsing dot beside
it. It never reported **state**. Those are not the same thing, and the gap is only visible in the one
situation that matters.

Roadie moves a record `fetching_metadata → downloading_art → generating_palette → awaiting_review` in
about 130ms. A sync's worth of transitions therefore lands inside a single minute, and the strip
renders at `HH:MM`. So after any sweep the strip shows one timestamp and then stops changing —
**identically**, whether Roadie finished everything it was given or died on the first record.

That ambiguity had a cost. Investigating "Roadie stopped and there's still work to do" meant ruling
out a ten-item cap, a stranded queue, an `enqueue`/`kick` race, and 23 albums suspected of skipping
palette generation. None existed: `current: null`, `queueDepth: 0`, `paused: false`, `errored: 0`,
499 of 499 records complete. Every one of those hypotheses would have been dismissed in a second by a
strip that said so.

The pulsing dot did not help, and could not. It pulsed unconditionally — `pp-dot--pulse` was
hard-coded — so it said "Roadie is present" while Roadie was doing nothing at all. Even wired
correctly it would be the wrong instrument: a pulsing and a still dot are the same shape and nearly
the same colour, and curator-ui-ux §3.4 already forbids leaning on that.

## Decision

The strip carries a **standing** — a mono word, in its own cell, saying where Roadie is right now.

| State                          | Label                   | Busy |
| ------------------------------ | ----------------------- | ---- |
| Poll hasn't answered yet       | `CHECKING…`             | no   |
| `paused`                       | `PAUSED`                | no   |
| No current record, empty queue | `IDLE · NOTHING QUEUED` | no   |
| Working, queue behind it       | `WORKING · n QUEUED`    | yes  |
| Working, nothing behind it     | `WORKING`               | yes  |

Four properties, each of which is the reason for one of the rows above:

- **The word is the signal; the dot is decoration.** The dot now pulses only when `busy`, but nothing
  depends on noticing that. §3.4 makes this a rule, and this project's own user is colour-blind.
- **Each label is literally true of the state it names.** `IDLE · NOTHING QUEUED` claims only that
  Roadie's queue is empty — not that the collection is finished. 482 records can still want your
  eyes. "All caught up" was rejected for exactly the reason ADR 0056 exists: it would be a label
  making a claim wider than the fact behind it.
- **Nothing is claimed before the first poll answers.** `CHECKING…`, not `IDLE`. Showing the resting
  state as a default would put a false claim on screen at the moment the user is being asked to start
  trusting this cell.
- **A queue with nothing in hand is `WORKING`, not idle.** That gap — enqueued, not yet picked up —
  is real, and reporting idle there would be a lie lasting exactly long enough for someone to catch
  it and stop believing the strip.

`roadieStanding` is a pure function over the status the app already polls, which lets `App` derive
the masthead's `roadieWorking` from it too. The masthead indicator and the strip disagreeing about
whether Roadie is busy is the same class of defect this ADR exists to close, so they now share one
definition rather than two that happen to match.

## Consequences

- `RoadieLog` takes a `status` prop, threaded through `Collection` from the poll that already lives
  in `App`. Deliberately not a second poll: §"Both polls live here rather than in the screens"
  applies, and the strip is a third consumer of a response two others already read.
- The strip gains a cell. It is `flex: none` and never ellipsises; the sentence beside it gives way
  first, which is correct — the sentence is history and the standing is state.
- The standing is `role="status"`, so it is announced rather than only drawn.
- The empty-collection case is unchanged and still slightly odd: with no grid to fill the viewport
  the dock sits mid-page rather than at the bottom. Pre-existing, cosmetic, and out of scope here.
- **Idle is styled faint, not accent.** An accent on "nothing to do" would read as something needing
  attention, which is the opposite of what it means.
