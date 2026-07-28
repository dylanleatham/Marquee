// The streaming effects themselves (hue-conductor-spec §9). Each is a factory that binds a palette +
// the room's lights + a few params and returns a pure `StreamRenderer` — `frame(tMs)` gives the
// per-light colors at that instant. These need the ~25 Hz Entertainment transport to render smoothly
// on real bulbs (the CLIP path is far too slow), but the math here is transport-agnostic and fully
// testable/previewable on its own (ADR 0023).
import { valueNoise2D } from "./noise.js";
import { sampleGradient } from "./gradient.js";
import type {
  LightColor,
  StreamFrame,
  StreamLight,
  StreamRenderer,
} from "./types.js";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const scale255 = (
  rgb: { r: number; g: number; b: number },
  mul: number,
): Omit<LightColor, "id"> => ({
  r: Math.round(rgb.r * mul),
  g: Math.round(rgb.g * mul),
  b: Math.round(rgb.b * mul),
});

/**
 * Each effect's parameter defaults, in one exported place (ADR 0036).
 *
 * The renderers below read from here rather than repeating literals, and `STREAM_PARAM_SPECS` in
 * `@marquee/contracts` mirrors these so Curator's sliders start at the right position. A test in
 * this package diffs the two — the mirror is what would otherwise rot silently, and a slider showing
 * the wrong "untouched" position for every album is not the kind of bug anyone reports.
 */
export const STREAM_RENDERER_DEFAULTS = {
  aurora: { speed: 0.06, scale: 1.2, brightness: 1 },
  shimmer: { speed: 1.5, intensity: 0.35 },
  wave: { speed: 0.25, angleDeg: 0 },
} as const;

export interface AuroraParams {
  /** Field units drifted per second — how fast the colors morph. Default 0.06. */
  speed?: number;
  /** Spatial frequency of the field — higher spreads more distinct colors across the room. Default 1.2. */
  scale?: number;
  /** Overall brightness 0..1. Default 1. */
  brightness?: number;
}

/**
 * Aurora — a slow flow-field drift. Each light samples a moving 2D noise field; the field value
 * picks a position along the palette gradient, so colors bleed and morph across the room like an
 * aurora or a lava lamp, never quite repeating. This is the flagship "ambient but alive" effect.
 */
export function aurora(
  lights: StreamLight[],
  hexes: string[],
  params: AuroraParams = {},
): StreamRenderer {
  const speed = params.speed ?? STREAM_RENDERER_DEFAULTS.aurora.speed;
  const spatial = params.scale ?? STREAM_RENDERER_DEFAULTS.aurora.scale;
  const bri = clamp01(
    params.brightness ?? STREAM_RENDERER_DEFAULTS.aurora.brightness,
  );
  return {
    frame(tMs: number): StreamFrame {
      const t = tMs / 1000;
      return lights.map((l) => {
        // Two axes drift at different rates → a swirling, non-repeating field.
        const field = valueNoise2D(
          l.x * spatial + t * speed * 3,
          l.y * spatial - t * speed,
        );
        return { id: l.id, ...scale255(sampleGradient(hexes, field), bri) };
      });
    },
  };
}

export interface ShimmerParams {
  /** Flicker speed (higher = faster twinkle). Default 1.5. */
  speed?: number;
  /** Brightness swing 0..1 (0 = steady, 1 = down to black at troughs). Default 0.35. */
  intensity?: number;
}

/**
 * Shimmer — a held palette with a candlelight twinkle. Each light keeps a fixed spot in the palette
 * gradient (spread across the room by index) while a per-light noise flicker rides its brightness up
 * and down. Only feels right at streaming rates; on the CLIP path it would stutter.
 */
export function shimmer(
  lights: StreamLight[],
  hexes: string[],
  params: ShimmerParams = {},
): StreamRenderer {
  const speed = params.speed ?? STREAM_RENDERER_DEFAULTS.shimmer.speed;
  const intensity = clamp01(
    params.intensity ?? STREAM_RENDERER_DEFAULTS.shimmer.intensity,
  );
  const n = lights.length;
  return {
    frame(tMs: number): StreamFrame {
      const t = tMs / 1000;
      return lights.map((l, i) => {
        const base = sampleGradient(hexes, n > 1 ? i / n : 0);
        const flicker = valueNoise2D(i * 7.13, t * speed); // 0..1, unique per light
        const mul = 1 - intensity + intensity * flicker; // (1-intensity)..1
        return { id: l.id, ...scale255(base, mul) };
      });
    },
  };
}

export interface WaveParams {
  /** Gradient cycles swept per second. Default 0.25. */
  speed?: number;
  /** Sweep direction in degrees (0 = left→right, 90 = rear→front). Default 0. */
  angleDeg?: number;
}

/**
 * Wave — the palette physically sweeps across the room. Each light's gradient position is offset by
 * its projection onto the sweep direction, so a band of color travels left→right (or any angle)
 * across the actual light layout. This is the effect that most needs real light *positions*.
 */
export function wave(
  lights: StreamLight[],
  hexes: string[],
  params: WaveParams = {},
): StreamRenderer {
  const speed = params.speed ?? STREAM_RENDERER_DEFAULTS.wave.speed;
  const angle =
    ((params.angleDeg ?? STREAM_RENDERER_DEFAULTS.wave.angleDeg) * Math.PI) /
    180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return {
    frame(tMs: number): StreamFrame {
      const t = tMs / 1000;
      return lights.map((l) => {
        // Project position onto the sweep axis and normalize xy∈[-1,1] roughly to [0,1].
        const along = (l.x * dx + l.y * dy + 2) / 4;
        const rgb = sampleGradient(hexes, along - t * speed);
        return { id: l.id, r: rgb.r, g: rgb.g, b: rgb.b };
      });
    },
  };
}

/** The effect names this module renders — the "streaming pattern" set (hue-conductor-spec §9). */
export const STREAM_EFFECTS = ["aurora", "shimmer", "wave"] as const;
export type StreamEffect = (typeof STREAM_EFFECTS)[number];

/** True if a pattern type names a streaming effect (vs. a CLIP pattern). */
export function isStreamEffect(type: string): type is StreamEffect {
  return (STREAM_EFFECTS as readonly string[]).includes(type);
}

/** Build the renderer for a streaming effect over a set of positioned lights and a palette. */
export function buildStreamRenderer(
  effect: StreamEffect,
  lights: StreamLight[],
  hexes: string[],
  params: AuroraParams & ShimmerParams & WaveParams = {},
): StreamRenderer {
  switch (effect) {
    case "aurora":
      return aurora(lights, hexes, params);
    case "shimmer":
      return shimmer(lights, hexes, params);
    case "wave":
      return wave(lights, hexes, params);
  }
}
