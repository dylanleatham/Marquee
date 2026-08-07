# ADR 0056 — Need labels name the act, not the artifact

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amends:** [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md), which set the four
  need labels.

## Context

The collection labels a record with its first outstanding need. Four labels, settled with the user
over three rounds of review: `NEEDS LIGHTS`, `NEEDS VISUALIZER`, `NEEDS CARD`, `NEEDS SIGN-OFF`.

`NEEDS LIGHTS` was wrong, and wrong in a way that cost real debugging time.

A record's palette exists within seconds of it landing — Roadie derives it in the last step of its
pipeline, before the record is ever shown as needing anything. What is outstanding is not the
palette. It is **sign-off**: `lightsDone` is `previewApprovedAt || state === "verified"`, and
approving means having watched the record in the room. The label named the artifact; the artifact was
never the missing thing.

The failure was not hypothetical. After a Discogs sync of 499 records, the collection showed 482
records reading `NEEDS LIGHTS`. **458 of them had a full palette** — 410 with four colours, 10 with
three, 38 with one. The remaining 24 were monochrome sleeves, correctly flagged. Roadie had finished
every record it was given, with an empty queue and zero errors.

This project's own user read that screen as "Roadie didn't look at the covers", and we went looking
for a stalled pipeline, a stranded queue, and a ten-item cap — none of which existed. The label was
the entire defect.

Two details made it worse rather than caught it:

- **Roadie is fast.** A record moves `fetching_metadata → downloading_art → generating_palette →
awaiting_review` in ~130ms, so a whole sync's worth of activity lands in the same minute. The log
  renders at `HH:MM`, so a finished Roadie and a wedged one produce the same frozen-looking strip.
- **The label was well tested.** Seven tests asserted `NEEDS LIGHTS`. They pinned the string
  perfectly and said nothing about whether it was true.

## Decision

**Every need label names the act the user still has to perform, never the artifact.**

| Need         | Label              | Why                                                                         |
| ------------ | ------------------ | --------------------------------------------------------------------------- |
| `lights`     | `NEEDS A LOOK`     | The palette exists; watching it in the room is what's left.                 |
| `visualizer` | `NEEDS VISUALIZER` | Names the artifact **because there genuinely isn't one**.                   |
| `card`       | `NEEDS CARD`       | Same.                                                                       |
| `tags`       | `NEEDS SIGN-OFF`   | Already followed the rule — the act is checking the tags, not burning them. |

Two of the four legitimately read as their artifact. That is not an inconsistency: the test is
whether the artifact is actually absent. For `visualizer` and `card` it is; for `lights` it never is.

The stat band's sentence moves with it — "three still need lights" becomes "three still need a look",
for the same reason and to keep one vocabulary.

`NEED_TAB_LABEL` is untouched. Those name sections on the record page ("Lights", "A card"), not
states, and a section is correctly named after its subject.

## Consequences

- `NEEDS A LOOK` is a change to vocabulary that was settled with the user; it was re-settled with
  them before this landed, on the strength of the 458-record evidence above.
- `needs.test.ts` gains the durable half: an assertion that the lights label does **not** match
  `/LIGHTS|PALETTE|COLOUR|COLOR/`, paired with a record that has a palette _and_ an outstanding
  lights need. Renaming it back to anything artifact-shaped fails in CI. The tags label gets the
  same guard. This is what the seven string assertions could not do — they proved the label was
  spelled consistently, not that it was honest.
- `curator-ui-ux` §5 and the design-handoff README are updated in this PR.
- The wider lesson is recorded here rather than only in the code: **a label is a claim.** A test that
  asserts a label's spelling proves the claim is stable, not that it is true. Where a label describes
  state the user cannot otherwise see, the test should pin it against a record in that state.

## What this does not change

Roadie's pipeline. It was never the problem: it ends at `awaiting_review` by design
([ADR 0027](0027-generation-is-invoked-not-pipelined.md)), and the work remaining on those 482
records — sign-off, a visualizer, card art, tags — is deliberately the user's or an explicitly
invoked generation, because Gemini calls cost money.
