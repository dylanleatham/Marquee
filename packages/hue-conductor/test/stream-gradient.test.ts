import { describe, it, expect } from "vitest";
import { sampleGradient } from "../src/stream/gradient.js";

const BW = ["#000000", "#FFFFFF"];

describe("sampleGradient", () => {
  it("an empty palette samples black", () => {
    expect(sampleGradient([], 0.5)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("a single color samples that color flat, at any t", () => {
    expect(sampleGradient(["#3366CC"], 0)).toEqual({
      r: 0x33,
      g: 0x66,
      b: 0xcc,
    });
    expect(sampleGradient(["#3366CC"], 0.9)).toEqual({
      r: 0x33,
      g: 0x66,
      b: 0xcc,
    });
  });

  it("t=0 is the first color exactly", () => {
    expect(sampleGradient(BW, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("wraps cyclically: t=1 returns to the first color", () => {
    expect(sampleGradient(BW, 1)).toEqual(sampleGradient(BW, 0));
  });

  it("blends between neighbors — quarter way is mid-grey for black↔white", () => {
    // n=2 → t=0.25 lands halfway through segment 0 (black→white).
    const mid = sampleGradient(BW, 0.25);
    expect(mid.r).toBeGreaterThan(118);
    expect(mid.r).toBeLessThan(138);
    expect(mid.r).toBe(mid.g);
    expect(mid.g).toBe(mid.b);
  });

  it("handles negative t (a backwards sweep) without breaking", () => {
    const c = sampleGradient(BW, -0.1);
    for (const ch of [c.r, c.g, c.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
    }
  });
});
