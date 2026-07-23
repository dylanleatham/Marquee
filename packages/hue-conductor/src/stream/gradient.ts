// A cyclic gradient over the album palette — the color source every streaming effect draws from.
// Sampling at a position t returns a color blended between palette entries; the gradient wraps
// (last → first) so sweeping or drifting through it never hits a seam. Interpolation is linear in
// sRGB — cheap, and good enough at the smooth, slow motion these effects use.
import { hexToRgb, type Rgb } from "../color.js";

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/**
 * Sample the palette as a cyclic gradient at position `t`. `t` wraps to [0, 1), which is then spread
 * across the palette so that t=0 is the first color, and the final segment blends the last color back
 * to the first. An empty palette samples black; a single color samples that color flat.
 */
export function sampleGradient(hexes: string[], t: number): Rgb {
  const n = hexes.length;
  if (n === 0) return { r: 0, g: 0, b: 0 };
  if (n === 1) return hexToRgb(hexes[0]!);

  const wrapped = ((t % 1) + 1) % 1; // → [0, 1) even for negative t (wave sweeps backwards)
  const scaled = wrapped * n; // n segments: the last wraps color[n-1] → color[0]
  const i = Math.floor(scaled) % n;
  const f = scaled - Math.floor(scaled);
  const a = hexToRgb(hexes[i]!);
  const b = hexToRgb(hexes[(i + 1) % n]!);
  return {
    r: Math.round(lerp(a.r, b.r, f)),
    g: Math.round(lerp(a.g, b.g, f)),
    b: Math.round(lerp(a.b, b.b, f)),
  };
}
