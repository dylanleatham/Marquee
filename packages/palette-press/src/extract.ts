// The one impure step: decode album art and pull raw swatches via node-vibrant.
// Everything downstream (postprocess, pattern) is pure.
import { Vibrant } from "node-vibrant/node";
import type { RawSwatches, RGB, SwatchName, ExtractOptions } from "./types.js";

interface Swatchish {
  rgb: [number, number, number];
  population: number;
}

const toRgb = (s: Swatchish | null | undefined): RGB | undefined =>
  s
    ? [Math.round(s.rgb[0]), Math.round(s.rgb[1]), Math.round(s.rgb[2])]
    : undefined;

export interface SwatchExtract {
  swatches: RawSwatches;
  /** Pixel population per swatch — drives dominant-color-first ordering. */
  populations: Partial<Record<SwatchName, number>>;
}

/** Extract swatches plus their populations. Internal; generatePalette uses this. */
export async function extractSwatches(
  artwork: Buffer,
  options: ExtractOptions = {},
): Promise<SwatchExtract> {
  const maxColorCount = options.maxColorCount ?? 64;
  const quality = options.quality ?? 3;

  let palette;
  try {
    palette = await Vibrant.from(artwork)
      .maxColorCount(maxColorCount)
      .quality(quality)
      .getPalette();
  } catch (err) {
    throw new Error(
      `Unreadable image bytes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const named: [SwatchName, Swatchish | null | undefined][] = [
    ["vibrant", palette.Vibrant],
    ["lightVibrant", palette.LightVibrant],
    ["darkVibrant", palette.DarkVibrant],
    ["muted", palette.Muted],
    ["lightMuted", palette.LightMuted],
    ["darkMuted", palette.DarkMuted],
  ];

  const swatches: RawSwatches = {};
  const populations: Partial<Record<SwatchName, number>> = {};
  for (const [name, s] of named) {
    const rgb = toRgb(s);
    if (rgb) {
      swatches[name] = rgb;
      populations[name] = s!.population;
    }
  }
  return { swatches, populations };
}

/**
 * Extract Vibrant's six named swatches from image bytes (spec-level lower API; RGB only).
 * Throws only on unreadable image bytes — an image that yields no usable swatches is a valid
 * (empty) result, not an error. `maxColorCount`/`quality` are pinned for deterministic output.
 */
export async function extractRawSwatches(
  artwork: Buffer,
  options: ExtractOptions = {},
): Promise<RawSwatches> {
  return (await extractSwatches(artwork, options)).swatches;
}
