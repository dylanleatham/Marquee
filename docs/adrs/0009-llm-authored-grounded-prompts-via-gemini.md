# ADR 0009 — LLM-authored, grounded prompts via Gemini (two-pass, variant sets, template fallback)

Status: accepted · Date: 2026-07-18 · Amends: [roadie-spec §7](../specs/roadie-spec.md) ("Prompt drafting")

## Context

Roadie's `drafting_prompts` step produced both prompts (visualizer video + printed card art) with a
**pure, deterministic template** — `draftPrompts()` in `packages/curator/src/roadie/prompts.ts`
stitched album metadata + palette into a fixed style body (`abstract_flow`, `iconic_emblem`, …).
roadie-spec §7 leaned on that purity as a feature: _"no external dependencies… deterministic given
inputs… fast, testable."_

The trouble is the output. Every album gets the same generic prompt skeleton — "abstract flowing
shapes drifting through the palette" — that references nothing concrete about the record. In
practice the far more effective prompts name **real artifacts and themes** from the album: the
cover's actual subjects, booklet/liner motifs, music-video imagery, the visual language of the era.
The maintainer had already been hand-writing "metaprompts" that steer an LLM to produce exactly that
(`docs/prompts/`), and pasting the results into the image/video tools by hand. All downstream
artifacts are generated on Google's Gemini stack (Nano Banana image, Omni/Veo video), so Gemini is
the natural engine for the prompt-writing too.

Two facts about the Gemini API shaped the design:

1. **Grounding is how you reference real artifacts.** Grounding with Google Search lets the model
   pull current, factual detail about an album's visual identity instead of hallucinating.
2. **Grounding and structured output can't share one call.** The `google_search` tool and a strict
   `responseSchema` (JSON mode) are mutually exclusive on a single `generateContent` request.

## Decision

**Roadie drafts prompts with Gemini by default, in a grounded two-pass flow that returns a _set_ of
variants per type, and falls back to the deterministic templates when Gemini is unavailable.**

1. **Two-pass generation** (`packages/curator/src/gemini/draft.ts`):
   - Pass 1 — a **grounded** call (`google_search`) researches the album's real visual identity
     (cover subjects, booklet/MV motifs, era aesthetic, textures, colors).
   - Pass 2 — a **structured-output** call (`responseSchema`, no tools) turns that research + the
     matching metaprompt into the prompt variants. The metaprompts (`docs/prompts/`) are bundled as
     runtime constants (`gemini/metaprompts.ts`) and kept in sync by a drift-guard test.

2. **Variant sets, human picks.** Each type is drafted as `PROMPT_VARIANTS` (5) distinct variants
   with deliberate variance nudges (framing, focal subject, motion emphasis, lighting, texture).
   `DraftedPrompt` now carries `{ variants: {text, nudge}[], selectedIndex, generator, template? }`;
   the human selects the active variant in the detail UI. This directly serves the downstream
   workflow (§Phase 2/3): 5 card-art candidates to choose from, and 5 short clips to splice.

3. **LLM-primary, template fallback.** If no Gemini key is configured or any call fails, the step
   falls back to the deterministic `draftPrompts` (tagged `generator: "template"`, single variant).
   The `drafting_prompts` step therefore still **cannot fail** — an album always reaches
   `awaiting_review` with prompts, LLM-authored or templated. A dead key never stalls onboarding.

4. **Provenance is recorded** on every draft (`generator: "gemini" | "template"`) and surfaced in
   the UI, so it's always clear whether a prompt was grounded or fell back.

5. **On-demand regeneration.** The detail UI keeps the deterministic template `<select>` (a
   `redraftPrompt`) and adds "Regenerate with AI" (`regeneratePromptWithAI`), which re-runs the
   grounded drafter for one type. Unlike the pipeline step, the manual regenerate has **no** silent
   fallback — on error the existing draft is left untouched and the error surfaces.

## Consequences

- **roadie-spec §7 no longer holds unconditionally.** Prompt drafting is now an external,
  non-deterministic call on the happy path. The purity/determinism guarantee survives only for the
  **template fallback**, which is now explicitly a fallback, not the primary path. §7 is updated to
  match (this ADR is linked from it).
- **Testing shifts** from golden-exact to structural for the LLM path: assert variant count,
  provenance, and grounded/structured call shape (against `@marquee/fake-gemini`), not exact text.
  The deterministic fallback keeps its goldens.
- **Cost/latency** enter the pipeline: three Gemini calls per album (one research + two drafts).
  Acceptable for a personal, low-throughput jukebox; the fallback bounds the failure blast radius.
- **Credentials**: a Gemini API key joins Spotify in the `config.toml → env → settings.json` chain
  and the in-app Settings screen (the packaged app has no repo `.env`).
- **The prompt is still the seam** (§7's original point): today a human copies/selects a prompt;
  the same drafts feed the automated image/video generation in the following phases.
