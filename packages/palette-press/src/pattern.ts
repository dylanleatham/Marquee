import type { AudioFeatures, Pattern, PaletteResult, RGB } from "./types.js";
import { rgbToHsv } from "./color.js";

// Pattern selection (palette-press-spec §7). Historically size-only + always-gentle; now
// energy-aware (ADR 0022): a vivid palette earns lively motion (rotate / pulse), a muted one keeps
// the calm crossfade/static it had before. "Energy" is read from the palette itself so every record
// feels distinct straight from its art; `audioFeatures` (when a caller has it — hand-authored today,
// since Spotify's endpoint is deprecated) overrides that read and tempo-locks the motion.

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const hexToRgb = (hex: string): RGB => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/** Above this palette energy, a multi-color palette rotates instead of crossfading. */
const ROTATE_THRESHOLD = 0.62;
/** Above this, a single-color palette breathes (pulse) instead of holding static. */
const PULSE_THRESHOLD = 0.66;

// Motion timing bounds, in ms — the slow end sits at the threshold, the fast end at max energy.
const ROTATE_SLOW_MS = 1600;
const ROTATE_FAST_MS = 700;
const PULSE_SLOW_MS = 3000;
const PULSE_FAST_MS = 1400;
/** Floor on a step interval: fast enough to feel alive, slow enough to stay under the rate limiter. */
const MIN_ROTATE_MS = 400;
/** Schema floor for a pulse period (integration-contract §2). */
const MIN_PULSE_MS = 200;

/**
 * How vivid a palette reads on the wall, 0..1 — a blend of mean saturation and brightness. Grey or
 * near-black palettes score ~0 (→ calm patterns); saturated, bright ones score high (→ lively).
 * Exported for testing and for callers that want the same read Palette Press uses.
 */
export function paletteEnergy(colors: ReadonlyArray<{ hex: string }>): number {
  if (colors.length === 0) return 0;
  let sumS = 0;
  let sumV = 0;
  for (const c of colors) {
    const { s, v } = rgbToHsv(hexToRgb(c.hex));
    sumS += s;
    sumV += v;
  }
  const meanS = sumS / colors.length;
  const meanV = sumV / colors.length;
  return clamp01(0.55 * meanS + 0.45 * meanV);
}

/** Fraction of the way from `lo` to full energy (1.0). 0 at the threshold, 1 at max. */
const above = (energy: number, lo: number): number =>
  clamp01((energy - lo) / (1 - lo));

/**
 * Snap a duration to the nearest whole number of beats, choosing among `beats` the multiple closest
 * to `baseMs`. A no-op when `tempo` is absent/invalid — so tempo-locking only kicks in with real data.
 */
function snapToBeat(
  baseMs: number,
  tempo: number | undefined,
  beats: number[],
): number {
  if (!tempo || tempo <= 0) return baseMs;
  const beatMs = 60000 / tempo;
  let best = baseMs;
  let bestErr = Infinity;
  for (const b of beats) {
    const cand = beatMs * b;
    const err = Math.abs(cand - baseMs);
    if (err < bestErr) {
      bestErr = err;
      best = cand;
    }
  }
  return best;
}

export interface SelectPatternOptions {
  /** When present, `energy` overrides the palette-derived read and `tempo` locks motion to the beat. */
  audioFeatures?: AudioFeatures;
}

/**
 * Choose the default pattern for a palette (palette-press-spec §7). Energy-aware: muted palettes keep
 * the historical static/crossfade defaults; vivid ones get rotate (2+ colors) or pulse (1 color),
 * with timing scaled by energy and tempo-locked when `audioFeatures.tempo` is supplied (ADR 0022).
 * The human can still override the result in Curator on the way to review.
 */
export function selectDefaultPattern(
  palette: Pick<PaletteResult, "colors"> & { insufficient?: boolean },
  opts: SelectPatternOptions = {},
): Pattern {
  const colors = palette.colors;
  const n = colors.length;

  // Insufficient art (monochrome, all-clamped) holds a calm static default: its colors were
  // saturation-boosted to floors during post-processing, so their "energy" is synthesized, not a
  // real read of the cover — not something to animate off of (ADR 0022). The human tunes it in review.
  if (palette.insufficient) return { type: "static", params: {} };

  const af = opts.audioFeatures;
  const energy =
    typeof af?.energy === "number" ? clamp01(af.energy) : paletteEnergy(colors);
  const tempo =
    typeof af?.tempo === "number" && af.tempo > 0 ? af.tempo : undefined;

  // Single color: breathe if it's vivid enough, otherwise hold it (unchanged default).
  if (n <= 1) {
    if (n === 1 && energy >= PULSE_THRESHOLD) {
      const t = above(energy, PULSE_THRESHOLD);
      const periodMs = Math.max(
        MIN_PULSE_MS,
        Math.round(
          snapToBeat(lerp(PULSE_SLOW_MS, PULSE_FAST_MS, t), tempo, [1, 2]),
        ),
      );
      return {
        type: "pulse",
        params: {
          periodMs,
          minBrightness: Math.round(lerp(55, 25, t)), // wider swing at higher energy
          maxBrightness: 100,
        },
      };
    }
    return { type: "static", params: {} };
  }

  // Multiple colors: rotate them around the room if vivid, else the gentle crossfade default.
  if (energy >= ROTATE_THRESHOLD) {
    const t = above(energy, ROTATE_THRESHOLD);
    const intervalMs = Math.max(
      MIN_ROTATE_MS,
      Math.round(
        snapToBeat(lerp(ROTATE_SLOW_MS, ROTATE_FAST_MS, t), tempo, [1, 2, 4]),
      ),
    );
    return { type: "rotate", params: { intervalMs, direction: "forward" } };
  }

  if (n === 2)
    return { type: "crossfade", params: { transitionMs: 8000, holdMs: 30000 } };
  return { type: "crossfade", params: { transitionMs: 12000, holdMs: 45000 } };
}
