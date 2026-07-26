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
  > **Superseded 2026-07-21 (issue #29) — see the "In-app splicing" addendum at the end of this ADR:**
  > in-app splicing landed, so the clips no longer have to leave Curator.

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
   > the future improvement was taken. `video/generate` now returns `202` with the job object
   > (`{ id, status, progress, … }`) and the clips generate in a background job the UI polls (`GET
/api/jobs/:id`, using that `id`); the synchronous held request is gone. The generation logic +
   > partial-success semantics here are otherwise unchanged.

## Consequences

- `AlbumAsset` gains `videoClips`; the VideoSection UI gains "Generate clips with AI" + a download
  gallery above the existing upload/player. Nothing downstream of `visualizer` changes.
- **The visualizer is now a short spliced loop**, not the single 3-minute render roadie-spec §7's
  template prose described. §7 is annotated accordingly; the template's "Duration: 3 minutes" line is
  now just the _template_ fallback's text, not a system guarantee.
- **In-app splicing is explicitly deferred** (an ffmpeg `concat` — ffmpeg is already bundled). Filed
  as a future enhancement; the clips are delivered for the maintainer's own editor meanwhile.
  > **Done 2026-07-21 (issue #29) — see the addendum below.**
- Cost enters on demand (N video generations per click), bounded by the human pressing the button,
  and metered/gated by Veo access on the key.

## Addendum 2026-07-21 — in-app splicing (issue #29)

The deferred in-app splice landed, so the generated clips no longer have to leave Curator:

- **`concat(files, out)`** on the ffmpeg wrapper (`media/video.ts`) — an ffmpeg `concat`-filter call
  (via the existing argv-only `run`, never a shell) that **re-encodes to H.264/MP4** so the output
  always passes `validateVideo`, regardless of the inputs' encodings. Video-only (`a=0`) — the
  runtime visualizer plays muted. The argv builder is exported (`buildConcatArgs`) and unit-tested.
- **`spliceVisualizer(curatorId, order?)`** — joins the selected clips (default: all, in index
  order; `order` reorders/deselects) into a temp MP4, then runs it through the **same `ingestVideo`
  path** as a manual upload, so validation, thumbnail, the `awaiting_preview` transition, and the
  Backdrop sync are identical. `POST /api/albums/:curatorId/video/splice`, body `{ order?: number[] }`.
- **UI**: the clip gallery gains a reorder/deselect list + a "Splice … into loop" button. The manual
  single-video upload remains the override; downloading a clip to edit externally still works.

Decision 3 above ("the human still uploads the final spliced loop") and the "In-app splicing is
explicitly deferred" consequence are **superseded** by this: splicing is now a one-click in-app
action. ~~Seamless-loop polish (crossfade at the seam) and normalizing mismatched clip dimensions
remain follow-ups — a plain concat of same-sized clips is the MVP.~~

**Update (2026-07-22, issue #56) — both follow-ups landed:**

- **Normalize mismatched dimensions** — `concat` now probes every input and, when their frames
  differ, scales-to-fit + pads each to the largest common size (`setsar=1`) before joining, so a
  mismatched clip set no longer fails or corrupts the concat. Same-size clips keep the original
  minimal filtergraph (no needless re-scale). The probe→build decision is a pure, unit-tested
  helper (`resolveConcatBuild`).
- **Seam crossfade** — an opt-in `crossfade` blends consecutive clips with `xfade` (offsets
  computed from each clip's probed duration) instead of a hard cut. Plain `concat` stays the
  default; the UI adds a "Crossfade the seams (0.5s)" checkbox and the route takes a bounded
  `crossfadeSec` (`POST …/video/splice`, body `{ order?, crossfadeSec? }`). The longer xfade encode
  is covered by the existing `CONCAT_TIMEOUT_MS`.

  _Still a further refinement:_ a dedicated **head/tail wrap** crossfade at the loop point (end→start)
  — the seam crossfade removes the hard cuts between clips, which is the dominant artifact; the single
  loop-seam blend is best tuned against real playback on the stand (step 12 / issue #53). Not blocking.
