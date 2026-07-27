# Palette Press

Pure library: album art bytes → `PalettePayload`. No I/O beyond image decoding, deterministic,
golden-testable. Spec: [../../docs/specs/palette-press-spec.md](../../docs/specs/palette-press-spec.md).

## API

```ts
import { generatePalette } from "@marquee/palette-press";
const payload = await generatePalette(artworkBuffer, {
  curatorId: "2k7bxq9m",
  name,
  artist,
  year,
});
// payload.palette.colors: [{ hex, cie_xy, role, sourceSwatch }], payload.pattern, ...
// payload.palette.insufficient === true (+ reason) for monochrome / unusable art.
```

Lower-level exports for testing/advanced use: `extractRawSwatches`, `postProcessPalette`,
`selectDefaultPattern`, plus the color helpers (`rgbToCieXy`, `deltaE`, `clampToGamutC`, …).

## Pipeline

1. **Extract** raw swatches via `node-vibrant` (pinned `maxColorCount`/`quality` for determinism).
2. **Order** dominant-color-first — highest pixel population _among the colorful swatches_, so a
   dull background can't outrank the album's signature color (this is what makes Purple Rain lead
   with purple and Kind of Blue with blue).
3. **Post-process**: monochrome guards (chroma floor + hue-spread), saturation/brightness floors,
   Hue gamut-C clamp, ΔE contrast filter, cap at 4, role assignment.
4. **Pattern**: energy-aware — static/crossfade for muted palettes, rotate/pulse for vivid ones,
   scaled by palette energy and tempo-locked when `audioFeatures` is supplied (ADR 0033).

All tuning is exposed via `PostProcessOptions` (floors, `maxColors`, `monochromeChroma`,
`hueSpreadDeg`, `orderColorFloor`, …) so behavior can be adjusted per-album from Curator.

## Fixtures & goldens

Fixture covers live in `fixtures/artwork/*.jpg`; committed reference palettes in
`fixtures/palettes/*.golden.json`. Current calibration meets the spec's success criteria on all
eight fixture albums (Purple Rain → purple, Kind of Blue → blue, the monochromes → `insufficient`).

- **Regenerate goldens** after an intentional algorithm change, then eyeball the diff before
  committing: `pnpm --filter @marquee/palette-press update-goldens`.
- Golden tests run everywhere — locally, on pre-push, and **in CI**. Comparison is **tolerant by
  choice, not necessity**: node-vibrant decodes via Jimp (pure JS), so extraction is deterministic
  across platforms and exact comparison would pass in CI too. We compare colors by **ΔE (< 12)**
  with structure exact so a golden fails on a _meaningful_ experience change (a primary flipping
  purple→orange is ΔE 50+) rather than on a trivial value nudge from a threshold tweak.
