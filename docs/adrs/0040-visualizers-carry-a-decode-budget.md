# ADR 0040 — Visualizers carry a decode budget, enforced on ingest

Status: accepted · Date: 2026-07-29 · Amends: backdrop-spec §4/§9/§13, curator-spec §9,
`packages/backdrop/DEPLOY.md` §9/§11b/§14 · Builds on:
[ADR 0011](0011-auto-generate-visualizer-clips.md) (generated clips, spliced into one loop),
[ADR 0038](0038-curator-pushes-media-over-http.md) (Curator pushes the file to the Pi) ·
Closes [#180](https://github.com/dylanleatham/Marquee/issues/180)

## Context

Videos glitched on the display: flicker, stutter, torn frames, continuously — while playing perfectly
in Curator's preview. That asymmetry was the clue.

**backdrop-spec §4 has been wrong since it was written.** It says:

> Why Pi 5 over Pi 4: Hardware-accelerated H.264 decode with headroom to spare.

The Pi 5's VideoCore VII **dropped** the Pi 4's H.264 decode block and kept only an HEVC decoder. Every
H.264 frame Backdrop plays is decoded on the CPU, inside Chromium, while the same CPU composites the
page. There is no "headroom to spare" — the Pi 5 is the _worse_ of the two boards for the codec this
system standardized on.

That error propagated into the code and the runbook, both of which push work toward the software
decoder:

- `ALLOWED_CODECS` in `media/video.ts` was commented `"H.264 always; H.265 for Pi 5"` — backwards.
- `DEPLOY.md` §9/§14 instruct the operator to re-encode HEVC **into** H.264, i.e. to convert the one
  codec the Pi 5 has silicon for into the one it doesn't.

Meanwhile nothing constrained what a visualizer could be. `ingestVideo` probed for container and codec
and then `copyFileSync`'d the file through untouched, and `buildConcatArgs` re-encoded spliced loops at
libx264's bare defaults — no bitrate ceiling, no GOP cap, no `+faststart`. Measured, every one of the
six visualizers in the store was:

| Property          | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Codec / profile   | H.264 Main, level 4.1                                 |
| Resolution / rate | 1920x1080 @ 30 fps                                    |
| **Bitrate**       | **~20 Mbps** (19.0–20.3 across all six)               |
| Audio             | AAC 192 kbps — playback is muted, so pure dead weight |
| GOP               | ~5.1 s keyframe spacing                               |
| `moov`            | at end of file, no `+faststart`                       |

1080p30 at 20 Mbps with long-GOP B-pyramids is at the edge of what four A76 cores sustain in a
browser. Curator's preview was never a check on this: a workstation has a hardware decoder and eats
20 Mbps without noticing, so the pipeline's only human checkpoint — "does the preview look right?" —
could not see the defect it was meant to catch.

## Decision

**Curator owns a decode budget, and no visualizer reaches the store without fitting inside it.**

1. **`DECODE_BUDGET` is one exported constant** in `media/video.ts`: ≤1920x1080, ≤30 fps,
   ≤10 Mbps accepted, H.264, no audio. It is the single place the runtime's decode limit is written
   down.

2. **`budgetViolations(info)` is a pure, tested predicate** returning _which_ of
   `codec | resolution | fps | bitrate | audio` are out of bounds. It checks only what actually costs
   the decoder — profile and level are set on encode but never checked, because Main vs High doesn't
   move software-decode cost and demanding it would buy a pointless re-encode.

3. **`ingestVideo` normalizes when over budget, and copies verbatim when not.** The encode targets
   8 Mbps (`-crf 21 -maxrate`, High/4.0, 2 s GOP, `-an`, `+faststart`) via `buildNormalizeArgs`, a
   pure argv builder asserted in tests without shelling out. Output goes to a temp and is renamed only
   on a clean finish — a half-written mp4 that _looks_ whole is worse than none, because Backdrop
   would play it.

4. **The accept ceiling (10 Mbps) sits above the encode target (8 Mbps) on purpose.** Without that
   margin a file we just produced could probe a hair over its own target and be re-encoded on every
   subsequent ingest.

5. **When a muted audio track is the only violation, the video stream is copied, not re-encoded.** An
   NLE export that already fits the budget shouldn't pay a full generation loss to drop a track the
   runtime never plays — and that is the common shape of a hand-edited upload.

6. **`buildConcatArgs` encodes to the same budget**, and `resolveConcatBuild` clamps an oversize clip
   set down to 1080p rather than joining up to the largest input. Identical settings on both paths are
   what let a spliced loop land in `ingestVideo` in-budget and be copied instead of encoded twice.

7. **`-preset veryfast`.** Decode cost is independent of encode preset, and this runs inside an upload
   request, so encode speed is the only axis that matters. Measured on the worst-case file in the
   store: 110 s of 1080p in 64 s (~0.6x realtime), versus 155 s at `medium`, for the same bitrate.

Separately, the Backdrop SPA stops fighting its own decoder — three fixes, all "don't spend decode
budget on something nobody can see":

- The idle overlay's `background-position` animation — full-screen, non-composited, `infinite` — used
  to keep repainting over every video frame, because the layer was only dropped to `opacity: 0` and
  left in the compositing path. It is now parked and `visibility: hidden` while playing.
- The outgoing video is paused when its fade **starts** rather than 450 ms later, so a swap no longer
  runs two software decodes at once.
- **`stop` now acts on both video layers.** It used to act on `active`, but the post-play role swap sits
  behind a 450 ms timer — so a `stop` landing inside that window faded out the _outgoing_ layer and left
  the just-started video playing indefinitely behind the idle overlay: invisible, never paused, still
  decoding. A real pre-existing bug, found by the first test ever written against the kiosk SPA (below)
  rather than by inspection, and squarely in this issue's family.

The kiosk launcher also passes GPU rasterization and zero-copy flags it previously omitted entirely.

**The kiosk SPA now has tests.** It never did — it's a vanilla IIFE meant for a browser, and a real
browser test stayed deferred for want of Playwright. That gap is what let the two playback bugs above
ship. `app.js` only reaches for `document`, `location` and `WebSocket`, so it can be driven by
shadowing those three as function parameters: no jsdom, no new dependency, and enough to pin playback
ordering and state. The CSS half genuinely needs a browser and is covered only by a guard that the
animation is not restored to its unconditional form.

## Consequences

- **Visualizers get ~2.7x smaller** (measured: 275 MB → 101 MB, 19.8 → 7.3 Mbps). Given the Pi's
  −72 dBm Wi-Fi and ADR 0038's HTTP push, that also cuts a ~90-minute transfer to roughly 35 minutes.
- **Upload gets slower.** `POST /api/videos/upload` now holds the request through an encode — ~0.6x
  the clip's duration — where it used to be a file copy. Consistent with `ingestVideo` already being
  documented as slow (the `#38` re-read-before-save pattern exists because of it), but a visible
  regression, and the obvious next move is to put the normalize behind the job manager the way
  [ADR 0018](0018-generation-runs-as-background-jobs.md) did for generation and
  [#178](https://github.com/dylanleatham/Marquee/pull/178) did for the media transfer. Filed as
  follow-up, deliberately not bundled here.
- **A conformant upload is bit-identical to before**, so nothing re-encodes on re-ingest and the
  splice path is unchanged in cost.
- **The six visualizers already in the store are not retroactively fixed** — normalization runs at
  ingest. `packages/curator/scripts/normalize-visualizers.mjs` re-encodes them in place for the
  backfill (importing the budget and the argv from `dist/`, so it can't drift from what ingest does); a
  `POST /api/backdrop/sync` afterwards re-pushes them.
- **HEVC is still transcoded to H.264 on ingest**, which is now an explicit choice rather than an
  accident of the wrong §4 claim: it is what Chromium on this Pi is verified to play. Whether Pi OS
  Chromium will use the Pi 5's HEVC hardware decoder for a `file://` `<video>` is a live question and
  the one real chance at a step change here — but it is an experiment, not an assumption, so the codec
  policy stays where the evidence is until someone runs it.
- **Curator's preview still can't catch a decode-budget defect** — it runs on hardware that doesn't
  care. The budget check is the substitute for that missing signal, which is why it lives at ingest
  (the one gate every visualizer passes through) rather than in the UI.
