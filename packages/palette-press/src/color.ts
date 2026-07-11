// Pure color math. No I/O, no dependencies — the deterministic heart of the library.
import type { RGB } from "./types.js";

/** Philips Hue gamut C triangle in CIE xy (most current color bulbs). */
export const HUE_GAMUT_C: readonly [number, number][] = [
  [0.6915, 0.3083], // red
  [0.17, 0.7], // green
  [0.1532, 0.0475], // blue
];

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex([r, g, b]: RGB): string {
  const h = (n: number) =>
    clamp255(n).toString(16).toUpperCase().padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB 0..255 → HSV with s, v in 0..1 and h in 0..360. */
export function rgbToHsv([r, g, b]: RGB): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV (h 0..360, s/v 0..1) → sRGB 0..255. Inverse of rgbToHsv. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [
    clamp255((r1 + m) * 255),
    clamp255((g1 + m) * 255),
    clamp255((b1 + m) * 255),
  ];
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** sRGB 0..255 → CIE XYZ (D65). */
export function rgbToXyz([r, g, b]: RGB): [number, number, number] {
  const R = srgbToLinear(r / 255);
  const G = srgbToLinear(g / 255);
  const B = srgbToLinear(b / 255);
  return [
    R * 0.4124 + G * 0.3576 + B * 0.1805,
    R * 0.2126 + G * 0.7152 + B * 0.0722,
    R * 0.0193 + G * 0.1192 + B * 0.9505,
  ];
}

/** sRGB 0..255 → CIE xy chromaticity. Black maps to [0, 0]. */
export function rgbToCieXy(rgb: RGB): [number, number] {
  const [x, y, z] = rgbToXyz(rgb);
  const sum = x + y + z;
  return sum === 0 ? [0, 0] : [x / sum, y / sum];
}

function xyzToLab([X, Y, Z]: [number, number, number]): [
  number,
  number,
  number,
] {
  const Xn = 0.95047;
  const Yn = 1.0;
  const Zn = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / Xn);
  const fy = f(Y / Yn);
  const fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Perceptual distance between two colors (CIE76 ΔE in Lab). */
export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = xyzToLab(rgbToXyz(a));
  const [l2, a2, b2] = xyzToLab(rgbToXyz(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// --- Gamut geometry (CIE xy) ---

type P = [number, number];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];

export function inGamutC([x, y]: P): boolean {
  const [A, B, C] = HUE_GAMUT_C as [P, P, P];
  const d1 = cross(sub([x, y], A), sub(B, A));
  const d2 = cross(sub([x, y], B), sub(C, B));
  const d3 = cross(sub([x, y], C), sub(A, C));
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos); // all same sign → inside (or on edge)
}

function closestOnSegment(p: P, a: P, b: P): P {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

/**
 * Project an xy point onto the nearest point of the gamut C triangle.
 * Returns the (possibly unchanged) point and how far it moved (max axis shift).
 */
export function clampToGamutC(p: P): { xy: P; shift: number } {
  if (inGamutC(p)) return { xy: p, shift: 0 };
  const [A, B, C] = HUE_GAMUT_C as [P, P, P];
  let best: P = A;
  let bestDist = Infinity;
  for (const [s, e] of [
    [A, B],
    [B, C],
    [C, A],
  ] as [P, P][]) {
    const q = closestOnSegment(p, s, e);
    const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (dist < bestDist) {
      bestDist = dist;
      best = q;
    }
  }
  return {
    xy: best,
    shift: Math.max(Math.abs(best[0] - p[0]), Math.abs(best[1] - p[1])),
  };
}
