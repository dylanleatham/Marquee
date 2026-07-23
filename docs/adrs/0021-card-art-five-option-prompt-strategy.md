# ADR 0021 — Card-art prompts: a five-option meta prompt, surfaced per-prompt with copy + generate

Status: accepted · Date: 2026-07-23 · Amends: [roadie-spec §7](../specs/roadie-spec.md) ("Prompt
drafting"), [curator-spec §Card art](../specs/curator-spec.md) · Builds on:
[ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md) (grounded LLM variant sets),
[ADR 0010](0010-auto-card-art-generation-candidate-set.md) (candidate-set generation)

## Context

ADR 0009 made Roadie draft the card-art prompt as a set of grounded LLM **variants** with generic
variance nudges ("vary framing, focal subject, lighting, texture"), and the detail UI let the human
**pick one** variant to copy/generate from. ADR 0010 added a whole-set "Generate options" job (one
Nano Banana image per variant) with a click-to-pick gallery.

Two things changed the maintainer's working practice:

1. **The meta prompt matured.** The card-art meta prompt in `docs/prompts/cardArtMetaPrompt.md` was
   rewritten from "two options" (Visual Translation / Art-Direction Translation) into **five
   fixed-angle options** — Cover Reimagining, Signature Motif, Visual Artist Provenance, Live
   Performance Era, Album Lore & Narrative Artifact — each demanding a tangible medium, the print
   safe-boundary, and an explicit `--ar 7:5`. The angles are deliberate and complementary, not
   interchangeable "variance."
2. **The workflow is copy-several, not pick-one.** The maintainer takes the prompts to **Google
   Flow** (and Midjourney) by hand to generate images, often trying more than one angle per album.
   Surfacing only the selected variant's text hid the other four behind a click.

## Decision

**Card-art prompts are authored from the five-option meta prompt, and the detail UI surfaces all
five at once — each individually copyable and individually generatable against Nano Banana.**

1. **Meta prompt (five fixed options).** `CARD_ART_METAPROMPT` (bundled at `gemini/metaprompts.ts`,
   canonical copy `docs/prompts/cardArtMetaPrompt.md`, kept in sync by the drift-guard test) now
   defines the five options above. The drafter's **card-art output override** (`gemini/draft.ts`)
   asks for those five options _in order_, each labelled with its option title as the variant
   `nudge`, instead of the generic "introduce deliberate variance" wording. The **video** override
   is unchanged (one loop, several angles to pick between). `PROMPT_VARIANTS` stays 5.

2. **All five surfaced, each copyable.** The "Card art prompt" section renders every drafted prompt
   in full with its own **Copy** button (records `copiedAt` — bookkeeping, per ADR 0005 — and writes
   that prompt to the clipboard). The pick-one radio is dropped for card art; the video prompt keeps
   it. "Regenerate with AI" (re-draft all five) and the deterministic template `<select>` stay.

3. **Per-prompt generation.** A new `POST /api/albums/:id/card-art/generate/:index` runs
   `generateCardArtOne(index)`: one `GeminiClient.generateImage(variant.text)`, ingested at
   `card-art/{curatorId}-c{index}.{ext}` and **merged** into `cardArtCandidates` (replacing that
   index, preserving siblings, under a re-read for #38). A single bounded image call, so it runs
   **synchronously** and returns the merged list — unlike the multi-minute whole-set path, it doesn't
   need the background-job model (ADR 0018). The per-prompt "Generate art" buttons drive it; the
   result lands in the same candidate gallery that `card-art/select` promotes from. Same opt-in gate
   as the set (Gemini key + `generateCardArt`, ADR 0012); an out-of-range index is a 400.

4. **The bulk "Generate options" job stays** (ADR 0010/0018) alongside the per-prompt buttons — the
   set is one click for all five; the per-prompt button regenerates just the angle you want to retry.

## Consequences

- The single attached `cardArt` contract, promotion path (`card-art/select`), print render, and the
  runtime are all unchanged — this is a drafting + detail-UI change plus one additive route.
- The card-art variant `nudge` now carries a stable option title (e.g. "Signature Motif") rather than
  an ad-hoc angle label; the candidate gallery and prompt list read from it directly.
- Cost stays on-demand and human-bounded: the set is N image calls per click; a per-prompt button is
  exactly one.
- **Spec reconciliation:** roadie-spec §7 (card-art metaprompt now five fixed options) and
  curator-spec §Card art (per-prompt copy/generate, the new route) are updated in this change, per
  "keep the specs honest."
- The "identify the visual artist" step the meta prompt opens with is folded into the drafting user
  turn (it grounds Option 3 and the mediums); the structured JSON output carries the five prompts,
  not the free-text artist header the manual chat workflow prints.
