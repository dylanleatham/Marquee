import type { Pattern, PaletteResult } from "./types.js";

/**
 * Deterministic default pattern from palette size (palette-press-spec §7). No audio features.
 * 1 color → static · 2 → gentle crossfade · 3+ → slower, longer crossfade.
 */
export function selectDefaultPattern(
  palette: Pick<PaletteResult, "colors">,
): Pattern {
  const n = palette.colors.length;
  if (n <= 1) return { type: "static", params: {} };
  if (n === 2)
    return { type: "crossfade", params: { transitionMs: 8000, holdMs: 30000 } };
  return { type: "crossfade", params: { transitionMs: 12000, holdMs: 45000 } };
}
