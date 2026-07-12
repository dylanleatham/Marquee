// @marquee/palette-press — album art → Hue-safe palette. Pure, deterministic, no I/O
// beyond image decoding. See docs/specs/palette-press-spec.md.

export { generatePalette } from "./generate.js";
export type { GeneratedPalettePayload } from "./generate.js";
export { extractRawSwatches } from "./extract.js";
export { postProcessPalette } from "./postprocess.js";
export { selectDefaultPattern } from "./pattern.js";

// Lower-level color helpers, exported for testing and advanced use.
export {
  toHex,
  rgbToHsv,
  hsvToRgb,
  rgbToCieXy,
  deltaE,
  inGamutC,
  clampToGamutC,
  HUE_GAMUT_C,
} from "./color.js";

export type {
  RGB,
  AlbumMetadata,
  ExtractOptions,
  PostProcessOptions,
  GenerateOptions,
  RawSwatches,
  Role,
  PaletteColor,
  Palette,
  InsufficientPaletteResult,
  PaletteResult,
  Pattern,
} from "./types.js";
