# Palette Press

Pure library: album art bytes → `PalettePayload`. No I/O, deterministic, golden-testable.
Spec: [../../docs/specs/palette-press-spec.md](../../docs/specs/palette-press-spec.md).

**First milestone:** `extractRawSwatches` returns the six named node-vibrant swatches for the
Purple Rain fixture. Then post-processing (gamut/saturation/brightness/contrast), insufficient
handling, role assignment, CIE xy, pattern selection, `generatePalette`, golden coverage.
