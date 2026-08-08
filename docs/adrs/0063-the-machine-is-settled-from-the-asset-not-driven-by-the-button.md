# ADR 0063 — The machine is settled from the asset, not driven by the button

- **Status:** Accepted
- **Date:** 2026-08-08
- **Extends:** [ADR 0062](0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md) to the
  one act it explicitly left open, and generalises its fix so there is no third instance.
- **Closes:** [#263](https://github.com/dylanleatham/Marquee/issues/263).

## Context

ADR 0062 took the tag step off the linear human state machine, and said plainly what it was not
doing:

> **The lights sign-off.** `canApprove` in the room is still `state === "awaiting_preview"`, so
> signing the lights off still waits on a visualizer being attached. That is the same shape of gate
> and may well be the same mistake, but it is a separate decision about a separate act.

It was the same mistake. This project's own user found it the same way, and reported it in almost
the same words as #261:

> There doesn't appear to be UI to confirm that lights have been approved. The circle is always open
> in the album menu and I can't mark it as verified.

`awaiting_preview` has exactly one entrance — `finishVideoAttach`. So on a record with no visualizer
the lights sign-off was not merely last in a reading order, it was **unreachable**, and `lightsDone`
(`previewApprovedAt || state === "verified"`) could never become true. The record page's Lights tab
showed `○` for the life of the record, on the same 478-of-499 records #261 was measured against.

Two smaller failures rode along with it, both visible in the rest of the same report:

> When I click "Looks Good" from inside a room, I am kicked out to the full album list and the album
> still has an open circle for light state

1. **The sign-off had no confirmation.** It called `navigate("/")` and fired the ready toast, so the
   room screen — the one place that owns the act — never showed that it had happened. The only
   acknowledgement was a toast, on a different screen, for five seconds.
2. **The toast was not true.** `ReadyToast` reads "<title> is ready · Lights, visualizer, card and
   tags — all done", and it fired on every sign-off regardless of what was outstanding. On a record
   that still needed a card and tags it announced the opposite of the truth, which is the likeliest
   reading of "the album still has an open circle" — the app said done and the record page said
   otherwise.

The deeper tell: ADR 0062 fixed the tag step by giving `verifyTags` its own settler, `settleTagStep`.
That fixed the instance. The **class** — a control that drives its own edge through a linear machine,
and is therefore dead whenever an earlier need is outstanding — was still there, and had one member
left.

## Decision

**Every human step records its evidence on the asset. One settler then walks the machine as far as
that evidence allows, and no control drives an edge of its own.**

1. **`approvePreview` never throws for being early.** It records
   `verification.previewApprovedAt` whatever the state, keeping the original timestamp on a repeat
   press, and then settles. The state gate is replaced by a gate on the **artifact**: a record with
   no palette is refused, because signing off means having watched the lights and there are none to
   watch. Unlike a state gate, that one cannot become unreachable in practice — Roadie derives a
   palette seconds after a record lands.

2. **`settleTagStep` becomes `settleNeeds`, and each step is gated on the evidence rather than on the
   caller.** `awaiting_preview → awaiting_tag_write` needs `previewApprovedAt`, and
   `awaiting_tag_write → awaiting_verify → verified` needs `physicallyVerifiedAt`. `approvePreview`,
   `verifyTags` **and** `finishVideoAttach` all call it. That last one is what closes the mirrored stranding: a record
   whose lights were signed off first would otherwise park at `awaiting_preview` forever, waiting for
   a sign-off that had already happened.

   ADR 0062 handled its own mirror with a special case (`approvePreview` continuing to `verified`
   when `physicallyVerifiedAt` was already set). Gating on evidence subsumes that case rather than
   adding a second one, which is why there is no third instance of this bug to write an ADR about.

3. **The sign-off confirms in place.** The room stays on screen and the control becomes a receipt —
   `● SIGNED OFF ✓`, disabled, with "Signed off <when>" beneath it. The ready toast keeps its meaning
   by firing only when it is true: when the sign-off was the **last** outstanding need, and returning
   to the collection is therefore what you want. `needs.ts` gains `needFactsOfAsset` so the room
   answers "was that the last one?" through the same predicates the collection draws its tiles with,
   rather than a second derivation that could disagree.

4. **The Lights tab says the state and how to change it.** A `●`/`○` on a tab reports a fact without
   offering a way to act on it, which is what "I can't mark it as verified" describes. The panel now
   carries one line — "signed off <when>", or "not signed off yet — see it in the room". It is a
   sentence and a link, never a second approve button: sign-off still means having just watched the
   record, which is not a claim a form can make on your behalf.

## Consequences

- `roadie.state` is now a **lagging summary** of both human steps, not just the tag one. The source
  of truth is `verification.previewApprovedAt` / `physicallyVerifiedAt` and `tag.*.written`. The UI
  has read the asset rather than the state since ADR 0052, so nothing on screen changes meaning.
- `verified` still means _every_ need is done. A record with signed-off lights and no visualizer is
  not verified and does not claim to be.
- `POST /api/albums/:id/preview/approve` returns `previewApprovedAt` alongside `state`, so the dock
  can confirm at once instead of a poll later. Additive; existing callers reading `state` are
  unaffected.
- **`rejectPreview` is untouched and still gated.** "Something's off" is a step _back_ through the
  machine (`awaiting_preview → awaiting_review`/`awaiting_video`), not a record of work done, so it
  has no evidence to settle from and legitimately answers to `HUMAN_TRANSITIONS`. Un-signing a record
  is not a thing the room offers.
- **`HUMAN_TRANSITIONS` is untouched**, exactly as in ADR 0062: no new edges, no state skipping. The
  resolution is that the sign-off stops needing an edge.
- One test was **replaced, not deleted** — `Room.test.tsx`'s "says why it can't be signed off yet
  rather than failing when pressed". It pinned `state === "awaiting_preview"` faithfully and, like
  the two ADR 0062 replaced, could not tell that the gate it described was unreachable for most of
  the collection. ADR 0056's lesson a third time: **a test that pins a claim proves the claim is
  stable, not that it is true.** The replacement presses the control from the state most of the
  collection is actually in.
- The blind spot this closes is the class, not the instance: with `settleNeeds` gated on evidence,
  a future human step is wired by recording its timestamp and adding one line to the settler. There
  is no longer a way to add a control that drives its own edge.
- `curator-ui-ux` §7 and §8.6, `curator-spec` §10 and `roadie-spec` §5 are updated in this PR.
