# ADR 0044 — Each workstation declares its primary action; Video and Card have none

Status: accepted · Date: 2026-07-31 · Amends:
[curator-ui-ux](../specs/curator-ui-ux.md) (§9.1 `Ctrl/⌘ Enter` row: deferred → built) · Extends:
[ADR 0026](0026-album-detail-is-a-workbench.md) (the detail is five workstations) · Part of
[#95](https://github.com/dylanleatham/Marquee/issues/95)

## Context

[curator-ui-ux §9.1](../specs/curator-ui-ux.md) specifies `Ctrl/⌘ Enter` as "primary action of the
current workstation". The binding is one line; the decision it depends on is not. **Which control is
primary** has no answer in `rail.ts`, where the workstation list lives, because the answer depends on
state the workstation owns — Look's primary is "save the palette", and only the palette editor knows
whether the draft differs from what is stored.

Three benches have an obvious answer. Look saves, Preview approves, Ship marks the tag written and
then records the physical check. Two do not: Video and Card each offer draft, generate, attach and
select, and none of those is the one a bench "is for" — they are alternative routes to the same
artifact, chosen by what you happen to be holding, which is the observation
[ADR 0026](0026-album-detail-is-a-workbench.md) was written on.

Guessing anyway is the tempting failure. A ⌘⏎ that "attaches the selected clip" fires a real mutation
from a keystroke on a bench where the user's intent was genuinely ambiguous, and one that "drafts the
prompt" can spend a Gemini call ([ADR 0027](0027-generation-is-invoked-not-pipelined.md)) from a
two-key accelerator.

## Decision

**The workstation declares its own primary action into a slot the detail page owns; ⌘⏎ fires
whatever is in the slot. Video and Card declare nothing, and the bench header says so.**

1. **`usePrimaryAction({ label, run, disabledReason? })`** (`ui/src/primaryAction.tsx`). The open
   workstation registers; unmounting or passing `null` hands the slot back.
2. **The bench header always names what ⌘⏎ will do** — the action's label, its reason if it cannot
   fire, or "No primary action on this workstation". This is what makes an inert key honest: §9.1
   requires that a shortcut never silently does nothing, and a state you can read before you press
   is not a silent one.
3. **The actions**, each of which is also an ordinary button on the bench:
   - **Look** — Save palette. Disabled, with the reason shown, when the draft matches what is
     stored. Re-extract and reset both throw work away; a bare accelerator should not reach them.
   - **Preview** — Looks good (approve). The two rejections stay mouse-only: they are the opposite
     verdict, and sending an album back is worth the extra half-second.
   - **Ship** — Mark sleeve tag written, then Mark physically verified. Two steps, so ⌘⏎ means "the
     next one", which is what a keyboard run of ten albums needs it to mean.
   - **Video, Card** — none.
4. **⌘⏎ obeys the field rule.** Like every other shortcut in §9.1, it does not fire while focus is in
   a text input. This costs something real — editing a hex swatch and pressing ⌘⏎ to save does not
   work, you must leave the field first — and it is still the right call: one rule for every binding
   is what makes the keyboard path predictable, and an exception for one key on one bench is how
   that stops being true.

### Why a registry rather than a table in `rail.ts`

Three properties fall out of the workstation owning its own declaration, and each is a bug that a
static table would have made easy to write:

- **The callable is current.** It is held in a ref refreshed every render, so ⌘⏎ saves the draft as
  it is now, not as it was when the bench mounted.
- **Handover is clean.** React runs every cleanup before any new effect, so switching benches would
  let the outgoing one wipe the incoming one's registration; only the current owner may clear the
  slot.
- **Re-registering is free.** The label is state (the header renders it) and is written only when it
  changes, so a workstation that re-declares on every render cannot loop.

## Consequences

- **A keyboard run through Ship works.** `]` to the next album at this state, `⌘⏎` to mark it —
  which is the flow [issue #94](https://github.com/dylanleatham/Marquee/issues/94) built `[`/`]` for.
- **"No primary action" is a visible answer, not a missing one.** Two of five benches show it, and a
  reader can tell the difference between "this bench has none" and "this shortcut is broken".
- **Adding a workstation means answering the question.** A new bench that declares nothing gets the
  honest default rather than a silent dud, so the cost of forgetting is small and legible.
- **A second place states what a control does.** The header label and the button's own text can
  drift. They are adjacent on screen, which is the cheapest available guard, and the labels name the
  effect ("Save palette") rather than the control ("Save").
- **Video and Card may get one later.** If a primary emerges from use — most likely "attach what is
  selected" — it is a one-line declaration in that bench, with no change to the binding.
