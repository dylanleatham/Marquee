# ADR 0062 — The tag step is recorded on the asset, not on the machine

- **Status:** Accepted
- **Date:** 2026-08-08
- **Resolves:** the tension [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) opened
  and [curator-ui-ux §5.2](../specs/curator-ui-ux.md#52-the-tags-panel) explicitly declined to settle:
  four needs done in any order, sitting on a linear human state machine.
- **Closes:** [#261](https://github.com/dylanleatham/Marquee/issues/261).

## Context

ADR 0052 replaced the nine-state queue with **four needs, done in any order** — lights, a visualizer,
a card, tags. `needs.ts` makes that true by construction: each need is an independent predicate over
the asset, so nothing in the derivation asserts an order.

The human state machine underneath it (`HUMAN_TRANSITIONS`, roadie-spec §5) is still a **line**:

```
awaiting_review → awaiting_video → awaiting_preview → awaiting_tag_write → awaiting_verify → verified
```

The two models met at exactly one control. `TAGS VERIFIED` enabled itself only for
`awaiting_tag_write` / `awaiting_verify`, because `verifyTags` ended in `transitionTo(asset,
"verified")` and anything earlier threw. curator-ui-ux §5.2 wrote that down honestly and left it:
_"That tension between 'any order' and a linear machine is real and is not resolved here — it is
simply not hidden."_

Shown, but not survivable. The only exit from `awaiting_review` is **attaching a visualizer** (or
copying the video prompt), then signing the lights off in the room. So the tag step was not merely
last in the reading order — it was gated behind two other needs.

On the real collection, after the Discogs sync of 499 records:

| state                | albums |
| -------------------- | ------ |
| `awaiting_review`    | 478    |
| `awaiting_tag_write` | 18     |
| `awaiting_preview`   | 2      |
| `needs_manual`       | 1      |

**478 of 499 records — 96% — could not record a tag at all.** And the panel had no second way: the
sleeve and the shelf card had no per-sticker control (only the demo tag did, added by
[ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) because `TAGS VERIFIED` deliberately skips it),
so both sat reading `not written yet` with nothing on screen able to change it. The disabled button's
reason — "The lights, a visualizer and a card come first — this is the last step" — was a true
description of the machine and a false description of the work. This project's own user read the
screen the only way it could be read: as broken.

The tell we missed: the reason names a **card** as a prerequisite, and attaching card art has never
touched the state machine. Half the sentence was already fiction.

## Decision

**Writing and checking a sticker is recorded on the asset, whatever the machine says. The machine
advances only as far as its own rules legally allow.**

Three parts:

1. **`verifyTags` never throws for being early.** It records both stickers written and
   `verification.physicallyVerifiedAt` unconditionally, then calls `settleTagStep`, which walks
   `awaiting_tag_write → awaiting_verify → verified` when it can and leaves the state alone when it
   can't. From `verified` there is nothing to do, so a second press is a no-op rather than a 409 —
   the panel keeps the button on screen after the check, so pressing it again is an ordinary thing
   to do.

2. **Every sticker records its own write.** `I'VE WRITTEN THIS ONE` now sits under the sleeve and the
   shelf card as well as the demo tag, wired to the per-object `tag-written` route, which never
   gated on state. The check is a separate act that happens hours or days later; a panel whose only
   control is the check has nothing to say the evening you burned the stickers.

3. **Whichever need lands second settles the machine.** `approvePreview` on a record that already
   carries `physicallyVerifiedAt` continues through to `verified` instead of parking at
   `awaiting_tag_write`. Without this, doing the tag step first would strand the record one step
   short of done forever — the same bug, mirrored.

`verified` keeps its meaning: **every** need is done. A record with checked tags and no visualizer is
not verified, and does not claim to be — `tagsDone` already counted `physicallyVerifiedAt` on its
own, so the collection tile and the tab glyph were correct all along and needed no change.

## Consequences

- The `TAGS VERIFIED` gate is now "have you already done this?", not "where is the record in the
  machine?". The only disabled state left is `checked <when>`.
- `roadie.state` stops being a complete account of the tag step. `verification.physicallyVerifiedAt`
  and `tag.*.written` are the source of truth; the state is a summary that lags when needs are done
  out of order. This is the honest shape — the UI has read the asset, not the state, since ADR 0052.
- The queue's `done_recently` bucket (`peers.ts`) still keys off `verified`, so a record with checked
  tags and outstanding needs stays in its own bucket. Correct: it is not done.
- Two tests that pinned the old behaviour were **replaced, not deleted** — `workflow.test.ts`'s
  "refuses before the record has reached the tag step" and `TagsPanel.test.tsx`'s "says why it can't
  be pressed yet". Both asserted the gate faithfully; neither could tell that the gate was
  unreachable in practice. This is [ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md)'s
  lesson a second time: **a test that pins a claim proves the claim is stable, not that it is true.**
  The guard that would have caught it is the one added here — a test that presses the control from
  the state 96% of the collection is actually in.
- `curator-ui-ux` §5.2, `curator-spec` §7 and `roadie-spec` §5 are updated in this PR.

## What this does not change

**The lights sign-off.** `canApprove` in the room is still `state === "awaiting_preview"`, so signing
the lights off still waits on a visualizer being attached. That is the same shape of gate and may
well be the same mistake, but it is a separate decision about a separate act — tracked as
[#263](https://github.com/dylanleatham/Marquee/issues/263) rather than widened into this one.

**The machine itself.** `HUMAN_TRANSITIONS` is untouched: no new edges, no state skipping. The
resolution is that the tag step stops _needing_ an edge, not that the line becomes a graph.
