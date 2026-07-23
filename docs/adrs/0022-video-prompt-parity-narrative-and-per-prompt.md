# ADR 0022 — Video prompts: a narrative meta prompt + per-prompt surface/generate (card-art parity)

Status: accepted · Date: 2026-07-23 · Amends: [roadie-spec §7](../specs/roadie-spec.md) ("Prompt
drafting"), [curator-spec §Video](../specs/curator-spec.md) · Builds on:
[ADR 0021](0021-card-art-five-option-prompt-strategy.md) (card-art five-option strategy),
[ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md) (grounded LLM variant sets),
[ADR 0011](0011-auto-generate-visualizer-clips.md) (visualizer clip set),
[ADR 0018](0018-generation-runs-as-background-jobs.md) (generation as background jobs)

## Context

ADR 0021 reworked the **card-art** prompt into a five fixed-angle meta prompt, surfaced every prompt
individually (each copyable), and added per-prompt Nano Banana generation. The maintainer wants the
same treatment for the **video** visualizer prompt — the workflow is identical (copy several prompts
to Google Flow by hand, or generate in-app), it was just never carried over.

Video differs from card art in three ways that shape the port:

1. **Two existing meta prompts.** Video already had `photo` (animate the cover, the default) and
   `abstract` (motion-design) styles, selectable via a `videoStyle` param — vs card art's single
   metaprompt. The maintainer wants to **keep both** and add the card-art angles as a third.
2. **The end product is a spliced loop, not a pick-one.** Generation produces a _set_ of short
   clips (ADR 0011) the human splices into one visualizer — so per-prompt generation regenerates a
   single **clip**, not a single final artifact.
3. **A clip is a multi-minute Omni call**, not a seconds-long image — so per-prompt video generation
   can't be synchronous the way per-prompt card art is; it must reuse the background-job model.

## Decision

**Port the card-art five-option strategy to video: add a "narrative" video meta prompt, surface every
video prompt individually (each copyable), and add per-prompt clip generation as index-keyed jobs.**

1. **Narrative meta prompt (new default).** `VIDEO_NARRATIVE_METAPROMPT`
   (`docs/prompts/visualizerMetaPromptNarrative.md`, bundled at `gemini/metaprompts.ts`, drift-guard
   tested) ports the card-art five fixed angles into motion — Cover in Motion, Signature Motif, Visual
   Artist Provenance, Live Performance Era, Album Lore & Narrative Artifact — as a 10-second seamless
   loop animating the cover. It is the **default** `videoStyle`; `photo` and `abstract` remain as the
   two existing alternates (still `videoStyle`-selectable, as before). The drafter's video override
   asks for the five defined options in order (labelled by option title) when the style is narrative,
   and keeps the generic-variance instruction for photo/abstract.

2. **All prompts surfaced, each copyable.** The "Video prompt" section renders every drafted prompt
   in full, each with its own **Copy** button — the same `PromptList` the card-art section uses. The
   pick-one variant radio is dropped for video too. Copying still records the copy and, at review,
   advances the album `awaiting_review → awaiting_video` (ADR 0005) — copying _any_ prompt is the
   signal.

3. **Per-prompt clip generation.** A new `POST /api/albums/:id/video/generate/:index` runs
   `generateVideoOne(index)`: one Omni image-to-video call off the cover, ingested to
   `visualizers/{curatorId}-v{index}.mp4` and **merged** into `videoClips` (replacing that index,
   preserving siblings, under a re-read for #38). Because a clip is multi-minute, it runs as a
   **background job** (ADR 0018) — but the job is keyed on `(curatorId, kind, index)`, so a per-clip
   run, the whole-set run, and other indices don't shadow each other in the dedup. The generated clip
   lands in the same clip gallery + splice controls the set feeds. Same opt-in gate as the set
   (Gemini key + `generateVideo` + cover art); an out-of-range index is a 400 precheck.

4. **The bulk "Generate clips" job stays** (ADR 0011/0018) alongside the per-prompt buttons — the set
   is one click for all five; the per-prompt button regenerates just the clip you want to retry.

## Consequences

- **Default video style changes** from `photo` to `narrative`, so LLM-drafted video prompts now carry
  the five fixed cinematic angles. `photo`/`abstract` are unchanged and still reachable via the
  `videoStyle` param; a UI selector for the three styles is deferred (they were param-only before).
- The `GenerationJob` gains an optional `index`, threaded through the job manager's dedup and the
  detail UI's re-attach — a small, backward-compatible extension (a whole-set job leaves it unset).
- The video variant `nudge` now carries the option title (narrative style) — the clip gallery and
  splice labels read from it directly, exactly as card art does.
- The visualizer contract, splice/attach path, and runtime are all unchanged — this is a drafting +
  detail-UI change plus one additive route and the job-index field.
- **Spec reconciliation:** roadie-spec §7 (video metaprompt now has a narrative default) and
  curator-spec §Video (per-prompt copy/generate, the new route) are updated in this change.
