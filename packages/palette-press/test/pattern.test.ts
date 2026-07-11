import { describe, it, expect } from "vitest";
import { selectDefaultPattern } from "../src/pattern.js";
import type { PaletteColor } from "../src/types.js";

const colors = (n: number): PaletteColor[] =>
  Array.from({ length: n }, (_, i) => ({
    hex: "#000000",
    cie_xy: [0.3, 0.3] as [number, number],
    role: i === 0 ? "primary" : i === 1 ? "secondary" : "accent",
    sourceSwatch: "Vibrant",
  }));

describe("selectDefaultPattern", () => {
  it("1 color → static", () => {
    expect(selectDefaultPattern({ colors: colors(1) })).toEqual({
      type: "static",
      params: {},
    });
  });
  it("2 colors → gentle crossfade", () => {
    expect(selectDefaultPattern({ colors: colors(2) })).toEqual({
      type: "crossfade",
      params: { transitionMs: 8000, holdMs: 30000 },
    });
  });
  it("3+ colors → slower crossfade", () => {
    expect(selectDefaultPattern({ colors: colors(4) })).toEqual({
      type: "crossfade",
      params: { transitionMs: 12000, holdMs: 45000 },
    });
  });
});
