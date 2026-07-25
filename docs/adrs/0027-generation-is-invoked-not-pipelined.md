# ADR 0027 — Gemini generation is invoked, never pipelined

Status: accepted · Date: 2026-07-25 · Amends: [ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md)
(Roadie drafts prompts during onboarding), roadie-spec §5 `drafting_prompts` · Extends:
[ADR 0012](0012-artifact-generation-is-opt-in.md)

## Context

[ADR 0012](0012-artifact-generation-is-opt-in.md) made **artifact** generation opt-in: card art
images and visualizer clips require a settings toggle plus an explicit button press, because they
cost money and most albums do not need them.

**Prompt drafting was never covered by that decision.** It remains an unconditional step in Roadie's
pipeline: `roadie/steps.ts:362` maps `drafting_prompts` to `draftPromptsStep`, which calls the
grounded two-pass Gemini drafter whenever a key is configured (`:335`), falling back to deterministic
templates only on error (`:349`). roadie-spec §5 states the step _"cannot fail."_

So every album added spends two Gemini calls — a grounding pass and a variant pass — authoring five
video prompts and five card-art prompts. That is correct for an album you intend to generate
artifacts for. It is pure waste for an album whose visualizer and card art you already have in hand,
which is a common case: the prompts are drafted, paid for, and never opened.

The cost is invisible at the point it is incurred (during background processing, before you look at
the album) and unavoidable short of removing the API key, which also disables the paths you do want.

## Decision

**Every Gemini call is the direct result of a user action.** Three rules:

1. **Prompt drafting is lazy.** It moves out of Roadie's pipeline. Roadie transitions
   `generating_palette → awaiting_review` directly. Prompts are drafted when the user opens the Video
   or Card workstation and asks for them; an undrafted section shows a **Draft prompts** button where
   the prompts would be.
2. **Never draft for a section whose artifact is already attached.** When `visualizer` exists, the
   Video workstation leads with the attached video and drafting becomes a secondary "regenerate"
   action. Same for `cardArt`.
3. **Spending is legible.** Controls that cost money are visually distinct from free ones and state
   what they will spend before being pressed — "Generate all 5" is five image calls, a per-prompt
   button is one. They are currently styled identically to **Copy**, which is free.

The deterministic template path costs nothing and is unaffected; it remains available on demand and
as the fallback when a Gemini call fails.

## Consequences

- **`awaiting_review` changes meaning.** It previously guaranteed "palette and prompts ready." It now
  guarantees "palette ready; prompts available on request." roadie-spec §5 carries a dated note.
- **`drafting_prompts` stops being a pipeline state.** It is retained as a state value for history
  entries on albums that already passed through it, and as the label for the on-demand action, but
  Roadie no longer transitions into it automatically.
- **The queue is unaffected.** Albums still land in `awaiting_review` for the human; only what has
  been pre-computed on arrival changes.
- **ADR 0009's mechanism survives intact** — grounded two-pass drafting, five variants, provenance
  recording, template fallback. Only its _trigger_ moves from the pipeline to the UI. This amends
  0009 rather than superseding it.
- **The rail is the invocation boundary** ([ADR 0026](0026-album-detail-is-a-workbench.md)): entering
  a workstation is the natural, explicit moment to ask for its prompts. The two decisions compose —
  the workbench makes lazy generation ergonomic instead of an extra hurdle.
- **Adding an album becomes free of API cost**, so bulk-adding a collection no longer bills for
  prompts on albums that may never need them.
- Roadie's onboarding gets faster and loses its only slow external dependency after art download.
- **[ADR 0025](0025-palette-edit-rejected-during-processing.md)'s guard becomes defensive rather than
  load-bearing.** That ADR identified `drafting_prompts` as _"the **only** contested window"_ for a
  palette edit — the one processing sub-step where a palette already exists. Removing it from the
  pipeline means no processing state has a palette, so the earlier states already reject edits with a
  400 ("palette isn't generated yet") and the 409 path should become unreachable in normal operation.
  **Keep the guard** — it is cheap, and it stays correct if a future step is inserted after palette
  generation — but a test asserting the 409 fires during `drafting_prompts` will need rewriting to
  drive that state directly rather than through the pipeline.
- **Trade-off accepted:** the "add 10 albums, walk away, come back to prompts ready" flow in
  curator-spec §2 now requires a click per album to draft. That is the intended exchange — the flow
  was only ever free-looking because the cost was hidden. Users who want the old behaviour can draft
  from the workstation in one action per album; a future batch "draft prompts for all" control is a
  natural addition if that proves tedious.
