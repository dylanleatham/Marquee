# ADR 0010 — Auto card-art generation as a pick-one candidate set (Nano Banana)

Status: accepted · Date: 2026-07-18 · Amends: [curator-spec §Card art](../specs/curator-spec.md) · Builds on: [ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md)

## Context

ADR 0009 made Roadie draft the card-art prompt as a set of grounded LLM **variants**. Until now the
human still took each prompt to an image tool by hand and uploaded the result. With the prompts
already LLM-authored on the Gemini stack, generating the images is the obvious next step — and the
maintainer wants to **pick the best of several**, not accept a single output, because image models
are stochastic and a card is a one-shot physical artifact.

The existing card-art model is a _single_ attached image (`AlbumAsset.cardArt`, served at
`/card-art`, keyed on disk as `card-art/{curatorId}.{ext}`), attached via manual upload.

## Decision

**Card art can be generated as a set of candidates — one image per drafted card-art prompt variant
(Nano Banana / `gemini-2.5-flash-image`) — and the human promotes one to the single attached card
art.** Manual upload stays as the override.

1. **Candidate set.** `POST /api/albums/:id/card-art/generate` runs `generateCardArtSet`: one
   `GeminiClient.generateImage(variant.text)` per card-art prompt variant, in parallel. Each result
   is stored at `card-art/{curatorId}-c{index}.{ext}` and recorded in a new
   `AlbumAsset.cardArtCandidates: CardArtCandidate[]` (index, fileId, ext, size, the variant's
   `nudge`). Served for preview at `/card-art/candidate/:index`.

2. **Partial failure is not total failure.** Generation uses `Promise.allSettled`; the successful
   images are kept and the failed ones are simply absent (indices preserved). Only an **all-fail**
   throws. One flaky image never discards the set.
   > **Updated 2026-07-21 by [ADR 0018](0018-generation-runs-as-background-jobs.md) (issue #30):**
   > generation now runs as a background job, so the all-fail case ends the **job** as `failed`
   > (polled via `GET /api/jobs/:id`) rather than surfacing as a synchronous 5xx. The partial-success
   > semantics are unchanged.

3. **Promotion reuses the normal path.** `POST /api/albums/:id/card-art/select { index }` copies the
   chosen candidate through the existing `ingestCardArt` (fileId = curatorId), so it lands at the
   canonical `card-art/{curatorId}.{ext}` that `/card-art` already serves. Nothing downstream of the
   attached `cardArt` changes; candidates remain on disk so you can re-pick.

4. **Requires a Gemini key.** No silent fallback here (unlike prompt drafting): generation is an
   explicit, human-triggered action, so a missing key is a 400 ("set an API key in Settings"), not a
   degraded result.

## Consequences

- `AlbumAsset` gains `cardArtCandidates`; the detail UI gains a "Generate options with AI" button and
  a click-to-pick thumbnail gallery above the existing attach/preview. The single `cardArt` contract
  is unchanged, so the runtime and print paths are untouched.
- Cost enters on demand (N image calls per click), bounded by the human pressing the button.
- **Video will follow the same shape** in the next phase (P3): a candidate _set_ of short Omni clips,
  delivered for download rather than promoted to a single artifact (in-app splicing deferred). This
  ADR establishes the candidate-set pattern; the video ADR will reference it.
- Deferred: the 300-DPI print render (curator-spec §Card art note) still serves the stored image
  verbatim — generation doesn't change that.
