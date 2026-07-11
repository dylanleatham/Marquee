import { describe, it, expect } from "vitest";
import {
  toHex,
  rgbToHsv,
  hsvToRgb,
  rgbToCieXy,
  deltaE,
  inGamutC,
  clampToGamutC,
} from "../src/color.js";
import type { RGB } from "../src/types.js";

describe("toHex", () => {
  it("formats uppercase #RRGGBB and clamps", () => {
    expect(toHex([75, 0, 130])).toBe("#4B0082");
    expect(toHex([300, -5, 255])).toBe("#FF00FF");
  });
});

describe("rgbToHsv / hsvToRgb", () => {
  it("round-trips within rounding tolerance", () => {
    for (const rgb of [
      [200, 20, 20],
      [20, 200, 20],
      [20, 20, 200],
      [123, 45, 200],
    ] as RGB[]) {
      const { h, s, v } = rgbToHsv(rgb);
      const back = hsvToRgb(h, s, v);
      for (let i = 0; i < 3; i++)
        expect(Math.abs(back[i]! - rgb[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it("reports grey as zero saturation", () => {
    expect(rgbToHsv([128, 128, 128]).s).toBe(0);
  });
});

describe("rgbToCieXy", () => {
  it("maps sRGB red near its known chromaticity", () => {
    const [x, y] = rgbToCieXy([255, 0, 0]);
    expect(x).toBeCloseTo(0.64, 2);
    expect(y).toBeCloseTo(0.33, 2);
  });
  it("maps black to the origin", () => {
    expect(rgbToCieXy([0, 0, 0])).toEqual([0, 0]);
  });
});

describe("deltaE", () => {
  it("is zero for identical colors and large for black vs white", () => {
    expect(deltaE([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(95);
  });
});

describe("gamut C", () => {
  it("accepts a point inside and rejects one clearly outside", () => {
    expect(inGamutC([0.31, 0.33])).toBe(true); // near white point
    expect(inGamutC([0.9, 0.9])).toBe(false);
  });
  it("clamping is a no-op inside and projects points outside back in", () => {
    expect(clampToGamutC([0.31, 0.33]).shift).toBe(0);
    const clamped = clampToGamutC([0.9, 0.9]);
    expect(clamped.shift).toBeGreaterThan(0);
    expect(clampToGamutC(clamped.xy).shift).toBeLessThan(1e-6); // idempotent
  });
});
