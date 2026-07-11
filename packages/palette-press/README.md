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
4. **Pattern**: static / crossfade by palette size.

All tuning is exposed via `PostProcessOptions` (floors, `maxColors`, `monochromeChroma`,
`hueSpreadDeg`, `orderColorFloor`, …) so behavior can be adjusted per-album from Curator.

## Fixtures & goldens

Fixture covers live in `fixtures/artwork/*.jpg`; committed reference palettes in
`fixtures/palettes/*.golden.json`. Current calibration meets the spec's success criteria on all
eight fixture albums (Purple Rain → purple, Kind of Blue → blue, the monochromes → `insufficient`).

- **Regenerate goldens** after an intentional algorithm change, then eyeball the diff before
  committing: `pnpm --filter @marquee/palette-press update-goldens`.
- Golden tests run locally and on pre-push (where you review them) but are **skipped in CI**:
  `sharp`'s platform binaries aren't guaranteed to quantize bit-identically across OSes. The
  deterministic pure-logic + property tests are the cross-platform regression guard.
