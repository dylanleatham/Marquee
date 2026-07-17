import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PalettePayload, PaletteColor } from "@marquee/contracts";
import { Store } from "../src/store.js";
import { BridgeAdapter } from "../src/bridge/adapter.js";
import { PlaybackEngine } from "../src/playback/engine.js";
import { makeFakeDriver, FakeTimers, type FakeOptions } from "./fakes.js";

const ROOM = {
  id: "1",
  name: "Living",
  type: "Room",
  lights: ["11", "12", "13"],
};

const COLORS: PaletteColor[] = [
  { hex: "#FF0000", role: "primary" },
  { hex: "#00FF00", role: "secondary" },
  { hex: "#0000FF", role: "accent" },
];

function setup(opts: FakeOptions = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), "conductor-engine-")));
  store.saveBridge({
    id: "BID",
    ip: "10.0.0.5",
    applicationKey: "k",
    pairedAt: "t",
  });
  const { driver, setCalls } = makeFakeDriver({ groups: [ROOM], ...opts });
  const bridge = new BridgeAdapter(store, driver);
  const timers = new FakeTimers();
  const engine = new PlaybackEngine(bridge, { timers });
  return { engine, timers, setCalls };
}

const payload = (
  type: PalettePayload["pattern"]["type"],
  params: PalettePayload["pattern"]["params"],
  colors: PaletteColor[] = COLORS,
): PalettePayload => ({
  version: 1,
  source: { type: "album" },
  palette: { colors },
  pattern: { type, params },
});

describe("PlaybackEngine", () => {
  it("static: assigns the palette across the room once, faded in, with no repeating timer", async () => {
    const { engine, timers, setCalls } = setup();
    await engine.start("1", payload("static", {}));

    expect(setCalls.map((c) => [c.lightId, c.rgb])).toEqual([
      ["11", [255, 0, 0]],
      ["12", [0, 255, 0]],
      ["13", [0, 0, 255]],
    ]);
    expect(setCalls.every((c) => c.on)).toBe(true);
    expect(setCalls.every((c) => c.transitionMs === 1500)).toBe(true); // fade-in
    // Static never schedules a pattern interval (only the 90-min idle safety net exists).
    expect(timers.activeAt(3000)).toBe(0);
  });

  it("crossfade: fades all lights to the next palette color on each hold tick", async () => {
    const { engine, timers, setCalls } = setup();
    await engine.start(
      "1",
      payload("crossfade", { transitionMs: 1000, holdMs: 3000 }),
    );
    // step 0 → primary red on all three lights
    expect(setCalls.every((c) => c.rgb?.join() === "255,0,0")).toBe(true);

    setCalls.length = 0;
    await timers.tick(3000, 1); // step 1 → green, using the pattern's own transition time
    expect(setCalls.map((c) => c.rgb)).toEqual([
      [0, 255, 0],
      [0, 255, 0],
      [0, 255, 0],
    ]);
    expect(setCalls.every((c) => c.transitionMs === 1000)).toBe(true);
  });

  it("rotate: shifts the palette across the lights each interval", async () => {
    const { engine, timers, setCalls } = setup();
    await engine.start(
      "1",
      payload("rotate", { intervalMs: 2000, direction: "forward" }),
    );

    setCalls.length = 0;
    await timers.tick(2000, 1); // forward shift by one
    expect(setCalls.map((c) => [c.lightId, c.rgb])).toEqual([
      ["11", [0, 255, 0]],
      ["12", [0, 0, 255]],
      ["13", [255, 0, 0]],
    ]);
  });

  it("pulse: holds the primary color and alternates brightness", async () => {
    const { engine, timers, setCalls } = setup();
    await engine.start(
      "1",
      payload("pulse", {
        periodMs: 2000,
        minBrightness: 20,
        maxBrightness: 100,
      }),
    );
    expect(setCalls.every((c) => c.rgb?.join() === "255,0,0")).toBe(true); // primary
    expect(setCalls.every((c) => c.bri === 100)).toBe(true); // max first

    setCalls.length = 0;
    await timers.tick(1000, 1); // half-period → dim to min
    expect(setCalls.every((c) => c.bri === 20)).toBe(true);
  });

  it("stop: restores the room to its pre-session snapshot and fades out", async () => {
    const { engine, setCalls } = setup({
      lightStates: {
        "11": { on: true, bri: 254, xy: [0.3, 0.3] },
        "12": { on: false },
        "13": { on: true, bri: 127 },
      },
    });
    await engine.start("1", payload("static", {}));
    setCalls.length = 0;

    await engine.stop("1");
    const byId = Object.fromEntries(setCalls.map((c) => [c.lightId, c]));
    expect(byId["11"]).toMatchObject({ on: true, xy: [0.3, 0.3], bri: 100 });
    expect(byId["12"]).toMatchObject({ on: false });
    expect(byId["13"]).toMatchObject({ on: true, bri: 50 }); // 127/254 ≈ 50%
    expect(setCalls.every((c) => c.transitionMs === 800)).toBe(true);
    expect(engine.isPlaying("1")).toBe(false);
  });

  it("swapping palettes mid-session keeps the original snapshot for restore", async () => {
    const seeded = { on: true, bri: 254, xy: [0.1, 0.1] as [number, number] };
    const { engine, setCalls } = setup({
      lightStates: { "11": seeded, "12": seeded, "13": seeded },
    });
    await engine.start("1", payload("static", {})); // snapshot captured here
    await engine.start(
      "1",
      payload("static", {}, [{ hex: "#FFFFFF", role: "primary" }]),
    ); // swap
    setCalls.length = 0;

    await engine.stop("1");
    // Restored to the pre-session xy, not the swapped-in white.
    expect(setCalls.every((c) => c.xy?.join() === "0.1,0.1")).toBe(true);
  });

  it("rejects a palette with no colors", async () => {
    const { engine } = setup();
    await expect(engine.start("1", payload("static", {}, []))).rejects.toThrow(
      /no colors/i,
    );
  });
});
