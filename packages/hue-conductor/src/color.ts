// Pure color helpers. Kept separate so they're trivially unit-testable.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse "#RRGGBB" (or "RRGGBB") into 0–255 channels. Throws on anything else. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m)
    throw new Error(
      `Invalid hex color: ${JSON.stringify(hex)} (expected #RRGGBB)`,
    );
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
