import { describe, it, expect } from "vitest";
import { selectDefaultPattern, paletteEnergy } from "../src/pattern.js";
import type { PaletteColor } from "../src/types.js";

// Build `n` palette colors that all share `hex` — energy is a function of hex, so this lets each
// test dial the palette's vividness independently of its size.
const colors = (n: number, hex = "#000000"): PaletteColor[] =>
  Array.from({ length: n }, (_, i) => ({
    hex,
    cie_xy: [0.3, 0.3] as [number, number],
    role: i === 0 ? "primary" : i === 1 ? "secondary" : "accent",
    sourceSwatch: "Vibrant",
  }));

const VIVID = "#FF0000"; // s=1, v=1 → energy 1.0
const MUTED = "#808080"; // grey → s=0, v≈0.5 → energy ≈0.23

describe("paletteEnergy", () => {
  it("empty palette → 0", () => {
    expect(paletteEnergy([])).toBe(0);
  });
  it("black → 0, grey → low, vivid → high", () => {
    expect(paletteEnergy(colors(1, "#000000"))).toBe(0);
    expect(paletteEnergy(colors(1, MUTED))).toBeLessThan(0.3);
    expect(paletteEnergy(colors(1, VIVID))).toBeGreaterThan(0.9);
  });
});

describe("selectDefaultPattern — muted palettes keep the historical defaults", () => {
  it("0 colors → static", () => {
    expect(selectDefaultPattern({ colors: colors(0) })).toEqual({
      type: "static",
      params: {},
    });
  });
  it("1 muted color → static", () => {
    expect(selectDefaultPattern({ colors: colors(1, MUTED) })).toEqual({
      type: "static",
      params: {},
    });
  });
  it("2 muted colors → gentle crossfade", () => {
    expect(selectDefaultPattern({ colors: colors(2, MUTED) })).toEqual({
      type: "crossfade",
      params: { transitionMs: 8000, holdMs: 30000 },
    });
  });
  it("3+ muted colors → slower crossfade", () => {
    expect(selectDefaultPattern({ colors: colors(4, MUTED) })).toEqual({
      type: "crossfade",
      params: { transitionMs: 12000, holdMs: 45000 },
    });
  });
  // The original size-only cases (black art) — unchanged, since black scores zero energy.
  it("1 black color → static", () => {
    expect(selectDefaultPattern({ colors: colors(1) })).toEqual({
      type: "static",
      params: {},
    });
  });
  it("2 black colors → gentle crossfade", () => {
    expect(selectDefaultPattern({ colors: colors(2) })).toEqual({
      type: "crossfade",
      params: { transitionMs: 8000, holdMs: 30000 },
    });
  });
});

describe("selectDefaultPattern — vivid palettes earn lively motion", () => {
  it("2+ vivid colors → rotate, timed by energy (fastest at max)", () => {
    expect(selectDefaultPattern({ colors: colors(3, VIVID) })).toEqual({
      type: "rotate",
      params: { intervalMs: 700, direction: "forward" },
    });
  });
  it("1 vivid color → pulse, widest brightness swing at max energy", () => {
    expect(selectDefaultPattern({ colors: colors(1, VIVID) })).toEqual({
      type: "pulse",
      params: { periodMs: 1400, minBrightness: 25, maxBrightness: 100 },
    });
  });
  it("rotate interval never dips below the rate-limit floor", () => {
    const p = selectDefaultPattern({ colors: colors(2, VIVID) });
    expect(p.type).toBe("rotate");
    if (p.type === "rotate")
      expect(p.params.intervalMs).toBeGreaterThanOrEqual(400);
  });
});

describe("selectDefaultPattern — audioFeatures override the palette read", () => {
  it("high energy forces motion on a muted palette", () => {
    const p = selectDefaultPattern(
      { colors: colors(3, MUTED) },
      { audioFeatures: { energy: 0.9 } },
    );
    expect(p.type).toBe("rotate");
    if (p.type === "rotate") {
      expect(p.params.intervalMs).toBeGreaterThanOrEqual(400);
      expect(p.params.intervalMs).toBeLessThanOrEqual(1600);
    }
  });
  it("low energy suppresses motion on a vivid palette", () => {
    expect(
      selectDefaultPattern(
        { colors: colors(3, VIVID) },
        { audioFeatures: { energy: 0.1 } },
      ).type,
    ).toBe("crossfade");
  });

  it("tempo snaps a rotate interval to the nearest beat multiple", () => {
    // energy 1.0 → base 700ms; tempo 120 → beat 500ms; multiples {500,1000,2000}; closest is 500.
    expect(
      selectDefaultPattern(
        { colors: colors(2, VIVID) },
        { audioFeatures: { energy: 1, tempo: 120 } },
      ),
    ).toEqual({
      type: "rotate",
      params: { intervalMs: 500, direction: "forward" },
    });
  });
  it("tempo snaps a pulse period to the nearest beat multiple", () => {
    // energy 1.0 → base 1400ms; tempo 120 → beat 500ms; multiples {500,1000}; closest is 1000.
    expect(
      selectDefaultPattern(
        { colors: colors(1, VIVID) },
        { audioFeatures: { energy: 1, tempo: 120 } },
      ),
    ).toEqual({
      type: "pulse",
      params: { periodMs: 1000, minBrightness: 25, maxBrightness: 100 },
    });
  });
  it("absent/zero tempo → no beat snapping", () => {
    const p = selectDefaultPattern(
      { colors: colors(2, VIVID) },
      { audioFeatures: { energy: 1, tempo: 0 } },
    );
    expect(p).toEqual({
      type: "rotate",
      params: { intervalMs: 700, direction: "forward" },
    });
  });
});

describe("selectDefaultPattern — insufficient palettes stay calm", () => {
  it("a boosted single vivid color from insufficient art holds static, not pulse", () => {
    expect(
      selectDefaultPattern({ colors: colors(1, VIVID), insufficient: true }),
    ).toEqual({ type: "static", params: {} });
  });
  it("insufficient wins even over hand-authored high energy", () => {
    expect(
      selectDefaultPattern(
        { colors: colors(1, VIVID), insufficient: true },
        { audioFeatures: { energy: 1 } },
      ),
    ).toEqual({ type: "static", params: {} });
  });
});
