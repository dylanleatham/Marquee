import { describe, it, expect } from "vitest";
import {
  aurora,
  shimmer,
  wave,
  STREAM_EFFECTS,
} from "../src/stream/renderers.js";
import type { StreamFrame, StreamLight } from "../src/stream/types.js";

const LIGHTS: StreamLight[] = [
  { id: "L", x: -1, y: 0 },
  { id: "C", x: 0, y: -1 },
  { id: "R", x: 1, y: 0 },
];
// Purple Rain's palette — distinct enough that spatial/temporal variation is visible.
const PALETTE = ["#7867A0", "#D5A370", "#D98D40", "#711E20"];

/** Every effect must return exactly one integer 0–255 color per light, ids preserved in order. */
function expectValidFrame(frame: StreamFrame, lights: StreamLight[]): void {
  expect(frame.map((c) => c.id)).toEqual(lights.map((l) => l.id));
  for (const c of frame) {
    for (const ch of [c.r, c.g, c.b]) {
      expect(Number.isInteger(ch)).toBe(true);
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
    }
  }
}

describe("STREAM_EFFECTS", () => {
  it("names the three streaming effects", () => {
    expect([...STREAM_EFFECTS]).toEqual(["aurora", "shimmer", "wave"]);
  });
});

describe("aurora", () => {
  it("is deterministic and produces valid frames", () => {
    const r = aurora(LIGHTS, PALETTE);
    expect(r.frame(1234)).toEqual(r.frame(1234));
    expectValidFrame(r.frame(1234), LIGHTS);
  });

  it("drifts over time (colors morph)", () => {
    const r = aurora(LIGHTS, PALETTE);
    expect(r.frame(0)).not.toEqual(r.frame(6000));
  });

  it("brightness 0 blacks out; brightness scales down", () => {
    const dark = aurora(LIGHTS, PALETTE, { brightness: 0 }).frame(1000);
    for (const c of dark) expect([c.r, c.g, c.b]).toEqual([0, 0, 0]);
  });

  it("an empty palette renders black without throwing", () => {
    const black = aurora(LIGHTS, []).frame(500);
    for (const c of black) expect([c.r, c.g, c.b]).toEqual([0, 0, 0]);
  });
});

describe("shimmer", () => {
  it("produces valid frames and spreads the palette across lights", () => {
    const r = shimmer(LIGHTS, PALETTE, { intensity: 0 });
    const f = r.frame(0);
    expectValidFrame(f, LIGHTS);
    // Distinct base colors per light (intensity 0 → pure gradient spread).
    expect(f[0]).not.toEqual(f[1]);
    expect(f[1]).not.toEqual(f[2]);
  });

  it("intensity 0 is steady over time; intensity>0 flickers", () => {
    const steady = shimmer(LIGHTS, PALETTE, { intensity: 0 });
    expect(steady.frame(0)).toEqual(steady.frame(3000));

    const alive = shimmer(LIGHTS, PALETTE, { intensity: 0.5 });
    expect(alive.frame(0)).not.toEqual(alive.frame(3000));
  });
});

describe("wave", () => {
  it("sweeps across positions — lights at different x differ at a fixed instant", () => {
    const f = wave(LIGHTS, PALETTE, { angleDeg: 0 }).frame(0);
    expectValidFrame(f, LIGHTS);
    // L (x=-1) and R (x=1) sit at different gradient positions.
    expect(f[0]).not.toEqual(f[2]);
  });

  it("is deterministic and moves over time", () => {
    const r = wave(LIGHTS, PALETTE);
    expect(r.frame(500)).toEqual(r.frame(500));
    expect(r.frame(0)).not.toEqual(r.frame(2000));
  });
});
