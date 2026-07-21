# ADR 0011 — Auto-generate the visualizer as downloadable Omni clips

Status: accepted · Date: 2026-07-18 · Amends: [curator-spec §Video](../specs/curator-spec.md), [roadie-spec §7](../specs/roadie-spec.md), [album-onboarding-workflow §"Awaiting video"](../specs/album-onboarding-workflow.md) · Builds on: [ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md), [ADR 0010](0010-auto-card-art-generation-candidate-set.md)

> **Superseded in part 2026-07-19 by [ADR 0013](0013-video-uses-gemini-omni-flash-interactions.md):**
> the "Veo long-running operation (poll then download)" API described below is wrong for the model
> actually available (`gemini-omni-flash-preview` via the **Interactions API**). The candidate-set /
> deliver-for-download / opt-in decisions here still stand; only the client's request/response shape
> and default slug changed. See ADR 0013.

## Context

ADR 0009 made Roadie draft the video prompt as grounded LLM **variants**; ADR 0010 established the
candidate-set pattern for card art. The visualizer is the last hand step: the maintainer's workflow
is to generate **several short (~8–10s) clips**, each from a slightly different prompt, then splice
them into one continuous loop that plays on Backdrop. The clips are generated image-to-video off the
**album cover** (the "Gemini Omni" / Veo image-referenced model the metaprompts target), so the
motion stays anchored to the real artwork.

Two forces shape the decision differently from card art:

- **Video generation is a long-running async operation** (minutes), not a synchronous call. The API
  returns an operation to poll, then a file to download.
- **The maintainer splices the clips themselves** (for now). The output of this step is _a set of
  clips to download_, not a single artifact to attach — the opposite of card art's "pick one."

## Decision

**Generate a set of visualizer clips — one per drafted video prompt variant, image-to-video off the
cover — and deliver them for download. Do not promote any clip to the single attached `visualizer`;
that stays set by the manual upload of the spliced result.**

1. **Long-running client method.** `GeminiClient.generateVideo(prompt, coverBytes)` starts the
   operation (`:predictLongRunning`), **polls to completion** with an injectable sleep + bounded
   poll count (`videoMaxPolls`, default ~10 min), then downloads the MP4. Timeouts and operation
   errors surface as `GeminiError`.

2. **Clip set.** `generateVideoSet` runs one `generateVideo` per video prompt variant in parallel,
   ingesting each through the existing `ingestVideo` (validation + thumbnail) keyed on
   `visualizers/{curatorId}-v{index}.mp4`, recorded in `AlbumAsset.videoClips: VideoClip[]`.
   **Generate + ingest run inside `Promise.allSettled`** (partial-keep, like card art); an all-fail
   throws as a **5xx** (a per-clip `VideoError` is wrapped so it isn't mis-mapped to 422). Requires a
   Gemini key **and** the album's cover art.

3. **Delivered, not promoted.** Clips are served at `/video/clip/:index` (+ `/thumbnail`, and
   `?download=1` for a named download). The UI shows a clip gallery with per-clip download. The
   single `visualizer` contract, the preview checkpoint, and the runtime are **unchanged** — the
   human still uploads the final spliced loop the usual way.

4. **Synchronous request for now.** The generate route holds the request while the clips generate.
   Acceptable for a single-user LAN app at this throughput; a background-job model (poll a job id)
   is the obvious future improvement if it becomes painful.
   > **Superseded 2026-07-21 by [ADR 0018](0018-generation-runs-as-background-jobs.md) (issue #30):**
   > the future improvement was taken. `video/generate` now returns `202 { jobId }` and the clips
   > generate in a background job the UI polls (`GET /api/jobs/:id`); the synchronous held request is
   > gone. The generation logic + partial-success semantics here are otherwise unchanged.

## Consequences

- `AlbumAsset` gains `videoClips`; the VideoSection UI gains "Generate clips with AI" + a download
  gallery above the existing upload/player. Nothing downstream of `visualizer` changes.
- **The visualizer is now a short spliced loop**, not the single 3-minute render roadie-spec §7's
  template prose described. §7 is annotated accordingly; the template's "Duration: 3 minutes" line is
  now just the _template_ fallback's text, not a system guarantee.
- **In-app splicing is explicitly deferred** (an ffmpeg `concat` — ffmpeg is already bundled). Filed
  as a future enhancement; the clips are delivered for the maintainer's own editor meanwhile.
- Cost enters on demand (N video generations per click), bounded by the human pressing the button,
  and metered/gated by Veo access on the key.
