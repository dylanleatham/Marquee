// Hue-aware post-processing: turn raw Vibrant swatches into a small, always-Hue-friendly
// palette (palette-press-spec §6). Pure and deterministic.
//
// Ordering: when swatch populations are supplied, the palette leads with the album's
// DOMINANT color (highest pixel population); otherwise it falls back to the fixed
// saturation-preference order. Role is assigned by final position (0 = primary).
import {
  SWATCH_ORDER,
  SWATCH_LABEL,
  type RGB,
  type SwatchName,
  type PaletteColor,
  type PaletteResult,
  type PostProcessOptions,
  type SwatchPopulations,
  type Role,
} from "./types.js";
import {
  rgbToHsv,
  hsvToRgb,
  rgbToCieXy,
  clampToGamutC,
  deltaE,
  toHex,
} from "./color.js";

const roleForIndex = (i: number): Role =>
  i === 0 ? "primary" : i === 1 ? "secondary" : "accent";

function toPaletteColor(rgb: RGB, name: SwatchName, role: Role): PaletteColor {
  const { xy } = clampToGamutC(rgbToCieXy(rgb));
  return {
    hex: toHex(rgb),
    cie_xy: xy,
    role,
    sourceSwatch: SWATCH_LABEL[name],
  };
}

/** Smallest hue arc (degrees) covering all hues; small = all one hue. */
function hueArc(hues: number[]): number {
  if (hues.length < 2) return 0;
  const sorted = [...hues].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + 360;
    maxGap = Math.max(maxGap, next - sorted[i]!);
  }
  return 360 - maxGap;
}

export function postProcessPalette(
  swatches: { [K in SwatchName]?: RGB },
  options: PostProcessOptions = {},
  populations?: SwatchPopulations,
): PaletteResult {
  const minSaturation = options.minSaturation ?? 0.15;
  const saturationBoost = options.saturationBoost ?? 0.4;
  const minBrightness = options.minBrightness ?? 0.25;
  const minDeltaE = options.minDeltaE ?? 15;
  const maxColors = options.maxColors ?? 4;
  const maxGamutShift = options.maxGamutShift ?? 0.1;
  const monochromeChroma = options.monochromeChroma ?? 0.12;
  const hueSpreadDeg = options.hueSpreadDeg ?? 10;

  const chroma = ([r, g, b]: RGB) =>
    (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

  // Present swatches in preference order; then, if we know populations, reorder so the
  // DOMINANT color leads — but only among the reasonably colorful swatches, so a dull
  // background (high population, low chroma) can't outrank the album's signature color.
  const present = SWATCH_ORDER.flatMap((name) => {
    const rgb = swatches[name];
    return rgb ? [{ name, rgb }] : [];
  });
  if (populations) {
    const colorFloor = options.orderColorFloor ?? 0.2;
    present.sort((a, b) => {
      const ca = chroma(a.rgb) >= colorFloor ? 1 : 0;
      const cb = chroma(b.rgb) >= colorFloor ? 1 : 0;
      if (ca !== cb) return cb - ca; // colorful swatches first
      return (populations[b.name] ?? 0) - (populations[a.name] ?? 0); // then most dominant
    });
  }

  if (present.length === 0) {
    return { colors: [], insufficient: true, reason: "unusable_art" };
  }

  // Monochrome guard #1 — near-black / near-white / greyscale art yields only faintly-tinted
  // swatches. Chroma (max−min channel) stays low for such art even when dark pixels read as
  // high-saturation, so gate on chroma before the brightness boost invents colors.
  if (Math.max(...present.map((p) => chroma(p.rgb))) < monochromeChroma) {
    return { colors: [], insufficient: true, reason: "monochrome" };
  }

  const accepted: { rgb: RGB; name: SwatchName }[] = [];
  let anyClampDropped = false;

  for (const { name, rgb } of present) {
    let working = rgb;

    // 1. Saturation floor.
    const hsvS = rgbToHsv(working);
    if (hsvS.s < minSaturation) {
      if (hsvS.s < 0.02) continue; // essentially grey — boosting an arbitrary hue looks wrong
      working = hsvToRgb(hsvS.h, saturationBoost, hsvS.v);
    }

    // 2. Brightness floor.
    const hsvB = rgbToHsv(working);
    if (hsvB.v < minBrightness)
      working = hsvToRgb(hsvB.h, hsvB.s, minBrightness);

    // 3. Gamut.
    if (clampToGamutC(rgbToCieXy(working)).shift > maxGamutShift) {
      anyClampDropped = true;
      continue;
    }

    // 4. Contrast.
    if (accepted.some((a) => deltaE(a.rgb, working) < minDeltaE)) continue;

    accepted.push({ rgb: working, name });
    if (accepted.length >= maxColors) break; // 5. cap
  }

  const colors = accepted.map((a, i) =>
    toPaletteColor(a.rgb, a.name, roleForIndex(i)),
  );

  if (colors.length >= 2) {
    // Monochrome guard #2 — the survivors are all essentially one hue (single-color source
    // with only lightness variation, e.g. an all-blue cover). Keep the dominant color only.
    if (hueArc(accepted.map((a) => rgbToHsv(a.rgb).h)) < hueSpreadDeg) {
      return { colors: [colors[0]!], insufficient: true, reason: "monochrome" };
    }
    return { colors, insufficient: false };
  }

  // Fewer than 2 usable colors is a valid business outcome, not an error.
  const reason =
    present.length < 2
      ? "monochrome"
      : anyClampDropped
        ? "all_clamped"
        : "monochrome";
  return { colors, insufficient: true, reason };
}
