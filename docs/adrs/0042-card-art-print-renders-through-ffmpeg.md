# ADR 0042 — The card-art print render goes through ffmpeg, cover-cropped, bleed opt-in

Status: accepted · Date: 2026-07-31 · Amends: curator-spec §Card art, `packages/curator/README.md`,
album-onboarding-workflow §"Print the card" · Builds on:
[ADR 0010](0010-auto-card-art-generation-candidate-set.md) (generated candidate set),
[ADR 0040](0040-visualizers-carry-a-decode-budget.md) (ffmpeg already owns Curator's media work) ·
Closes [#98](https://github.com/dylanleatham/Marquee/issues/98)

## Context

curator-spec §Card art has carried two contradictory statements since build step 7. An
implementation note said:

> `/card-art/print` serves the stored image verbatim; the 300-DPI print render is **deferred until
> Curator gains an image pipeline**.

And the API table, one row below, promised:

> Serves a print-optimized version (300 DPI, standard business-card dimensions) suitable for sending
> to a printer.

The route did the former. The UI's "Download print" button was wired to it, and what came back was
the source file with a `Content-Disposition` on it. For a feature whose entire point is a physical
card you print and stick an NFC tag to, that is the gap between "download" and "printable".

Two things made it worse than the note implies:

1. **Nothing in the suite touched the route.** No test named `card-art/print` existed, so the note
   and the table could disagree indefinitely without anything going red.
2. **Off-size art is the common case, not the edge case.** The note assumes the stored art is already
   1050x600 and only lacks metadata. But `generateImage` sends Nano Banana no aspect-ratio
   configuration, so a generated candidate comes back square — and the upload path deliberately
   accepts any size. Stamping 300 DPI onto a 1024x1024 candidate yields a 3.4-inch square, which is
   not a business card.

So the render needs real geometry, which is what "gains an image pipeline" was waiting for.

## Decision

### 1. The image pipeline is ffmpeg, not `sharp`

The issue assumed `sharp`. It is the conventional answer and has the better resampler, but it is a
native module, and Curator's native modules are not free here: the desktop app bundles the server
with esbuild, so anything with a `.node` binary must be left external and staged into
`resources/servers/node_modules` by hand. Getting that wrong is exactly how
[#125](https://github.com/dylanleatham/Marquee/issues/125) presented — a packaged app that died at
boot on `Cannot find module`. `sharp` would mean a new `RUNTIME_NATIVE_DEPS` entry plus its `@img/*`
platform binaries, and ~10 MB per platform in the installer.

ffmpeg costs none of that. It is already a documented Curator dependency, already staged into the
packaged app (`ffmpeg-static`/`ffprobe-static` → `resources/ffmpeg/`), and already driven through
`media/video.ts`'s `run()`, which passes argv without a shell and kills the process past a timeout.
Scaling and cropping a still is well inside what it does.

The one thing ffmpeg will not do is write DPI metadata — it emits neither a PNG `pHYs` chunk nor a
JPEG JFIF density. That turns out not to matter: both are a fixed handful of bytes at a known offset,
so `media/print.ts` writes them directly. No decoder needed, and it would have been hand-rolled under
`sharp` too (`sharp`'s `withMetadata({density})` covers it, but only for the sizes it also re-encodes).

### 2. Off-size art is scaled to cover and centre-cropped

The alternatives were letterboxing and refusing. Letterboxing puts bars on a physical card, which
reads as a printing mistake once it is in your hand. Refusing breaks the button for most real albums,
which is arguably worse than what shipped.

Cover-cropping is also what the art is _authored_ for: `docs/prompts/cardArtMetaPrompt.md` already
tells Gemini "full bleed, edge-to-edge artwork only (keep main focal points centered within a 144px
safe boundary to allow for print trimming)". Cropping the overflow off a full-bleed image with a
centred focal point is the intended operation, not a compromise.

Orientation follows the source — art taller than it is wide gets a 600x1050 portrait card rather than
being rotated — because the upload path already records `orientation` and a portrait card is a real
thing.

Upscaling is allowed without a ceiling. A 400x400 source will print soft, but the human chose that
image, the resolution is displayed next to it in the UI, and a hard refusal at some arbitrary
threshold buys less than it costs.

### 3. Bleed is opt-in; the default is the trim size

`GET …/card-art/print` returns 1050x600 — exactly 3.5in x 2in at 300 DPI, which is what the spec
table promises and what you want when printing and cutting at home. `?bleed=1` returns 1125x675, the
same card with 0.125in past the trim line on every edge, for a commercial printer. The 144px safe
boundary above already keeps the focal point clear of a 37.5px trim.

### 4. A missing ffmpeg is a 503; a rejected file is a 422

`VideoError` gained a `binaryUnavailable` flag, set on the spawn-error path in `run()`, and
`PrintError` carries it up as `kind: "unavailable" | "failed"`. The route answers 503 for the former
and 422 for the latter — the same split the upload path already makes. Reporting "ffmpeg isn't
installed" as a bad file sends you looking in the wrong place.

Art that is _already_ exactly card-sized skips ffmpeg entirely and only gets the DPI stamp, so the
button still works on a workstation with no ffmpeg — preserving the README's "video attach needs
ffmpeg; everything else works without it" for the case where it can be preserved honestly.

### 5. The UI fetches the render instead of linking to it

"Download print" was an `<a download>` pointing at the route. Now that the route can answer 422/503,
that would show the human a page of JSON. It is an `AsyncButton` calling
`api.downloadCardArtPrint`, so a failure lands in the same error channel as every other action and
the button says "Rendering…" while ffmpeg works.

## Consequences

- The spec's two statements agree for the first time; the deferral note is superseded, not deleted.
- Curator gains no new dependency, and the desktop installer is unchanged.
- The print download now spawns a process. It is bounded (30s) like every other ffmpeg call, and it
  is a human clicking a button, not a hot path — but it is a spawn per click, with no caching. If
  that ever matters, cache at `card-art/{curatorId}-print.png` keyed on `cardArt.attachedAt`.
- Rendering happens at request time, so replacing the art needs no invalidation anywhere.
- ffmpeg's `lanczos` is a slightly worse upscaler than `sharp`'s. At these sizes, on art that is
  mostly generated gradients and emblems, that is not a difference you can see on a printed card.
- `FFMPEG_PATH` is now read per call (`ffmpegBin()`) rather than once at import, so setting it after
  the module loads takes effect. That is also what makes the 503 path testable.
