import { describe, it, expect } from "vitest";
import { valueNoise2D } from "../src/stream/noise.js";

describe("valueNoise2D", () => {
  it("is deterministic", () => {
    expect(valueNoise2D(1.5, 2.5)).toBe(valueNoise2D(1.5, 2.5));
    expect(valueNoise2D(-3.2, 7.9)).toBe(valueNoise2D(-3.2, 7.9));
  });

  it("stays within [0, 1) across a grid", () => {
    for (let x = -5; x <= 5; x += 0.37) {
      for (let y = -5; y <= 5; y += 0.41) {
        const v = valueNoise2D(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("is continuous — a small step moves the value only a little", () => {
    for (let x = -2; x <= 2; x += 0.5) {
      const delta = Math.abs(valueNoise2D(x, 0) - valueNoise2D(x + 0.01, 0));
      expect(delta).toBeLessThan(0.05);
    }
  });

  it("actually varies across the field (not a constant)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 20; i++) samples.add(valueNoise2D(i * 1.3, i * 0.7));
    expect(samples.size).toBeGreaterThan(10);
  });
});
