# ADR 0026 — Curator's album detail is a workbench, not a guided session

Status: accepted · Date: 2026-07-25 · Supersedes: curator-spec §3 ("session-shaped"), §10
("Album detail (session-shaped)"), §11 milestone 9 · Amends: album-onboarding-workflow §12
("Album detail is a stateful view") · Generalizes: [ADR 0005](0005-video-attach-does-not-require-copying-the-prompt.md)

## Context

`curator-spec.md` §10 specified the album detail page as session-shaped: _"Completed sections
collapse to one-line summary. Current section expanded."_ Milestone 9 restated it as _"see current
state highlighted, complete steps in order."_ The premise is that an album moves through Roadie's
state machine one step at a time, and the UI should reveal the step you are on.

Real use does not work that way. Artifacts arrive out of order: a visualizer already rendered before
the palette has been looked at, card art commissioned before a video exists. Under a session shape
those cases are unrepresentable — you must first perform an earlier step you do not need in order to
unlock a drop zone for an artifact you already hold.

The implementation had already drifted in both directions at once, incoherently:

- It renders **every** section expanded, always — no collapsing (the session half was never built).
- But it **hides** two sections behind state gates: Preview only at `awaiting_preview`
  (`AlbumDetail.tsx:227`), Tag & verify only at `awaiting_tag_write | awaiting_verify | verified`
  (`:284`).
- And `inWorkflow = !processing && palette != null` (`:106`) hides the **entire** workflow while
  Roadie is still fetching metadata — precisely the case where a user holding a finished video cannot
  hand it over.

[ADR 0005](0005-video-attach-does-not-require-copying-the-prompt.md) had already decided this
question for one section — the video drop zone is live from `awaiting_review` onward, no prompt copy
required — but framed it as a fact about video attachment rather than as a principle. Every section
added afterward re-decided it privately, and two landed on "hide."

The two specs also disagreed with each other. `album-onboarding-workflow.md:117` states _"Each state
is independent — you don't have to complete 'review palette' and 'attach video' in the same
session,"_ while §12 of the same document says sections are _"collapsed or hidden depending on what
makes sense."_

## Decision

**The album detail page is a workbench.** Its governing rule:

> Providing an artifact is never gated. Advancing state is gated — and the gate is shown, not hidden.

1. **No section is ever hidden or unavailable because of `roadie.state`.** Drop zones, palette edits,
   prompt copies, artwork overrides and downloads are live whenever their own inputs exist, including
   while Roadie is still processing the album.
2. **Actions with genuine API preconditions render disabled with the reason stated in place** — never
   absent. An absent control is indistinguishable from a control that does not exist.
3. **`roadie.state` drives emphasis and queue placement only** — the default-selected workstation and
   the queue bucket. Never availability.
4. The page is organized as **five workstations behind a rail** (Look · Video · Card · Preview ·
   Ship), not as an ordered scroll of sections. See [curator-ui-ux.md](../specs/curator-ui-ux.md) §5.

The single legitimate hard block remains a write conflict, not a workflow gate: palette actions
return `409` while Roadie is processing ([ADR 0025](0025-palette-edit-rejected-during-processing.md)).

## Consequences

- **The spec changes, not the intent behind the queue.** Roadie's state machine is untouched, and the
  queue view — which genuinely is state-shaped, and works well — is unaffected. This scopes the
  workbench claim to the detail page.
- **Three gates come out of `AlbumDetail.tsx`**: the Preview state check, the Tag & verify state
  check, and `inWorkflow`'s dependency on `palette != null`.
- **Density needs a spatial answer.** A session would have controlled page length by collapsing
  completed sections; a workbench cannot. With five video prompts and five card-art prompts rendered
  in full ([ADRs 0021](0021-card-art-five-option-prompt-strategy.md) /
  [0022](0022-video-prompt-parity-narrative-and-per-prompt.md)), the rail is what keeps the page
  workable — the layout is load-bearing, not cosmetic.
- **The rail also spends the unused window.** `.page` capped content at `920px` inside a `1360px`
  window; the rail occupies what was empty gutter.
- **Readiness replaces permission.** Each rail item reports _empty · ready · attached · blocked_ as a
  dot **plus a word** (curator-ui-ux §3.4), so state stays visible without becoming a lock.
- **Four documented facts change**, listed in the header above; each carries a dated pointer here.
- If a genuinely linear sub-flow is ever needed, it belongs inside a single workstation, not as a
  re-litigation of the page shape. A superseding ADR would record that.
