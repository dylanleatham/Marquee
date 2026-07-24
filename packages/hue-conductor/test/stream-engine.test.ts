import { describe, it, expect } from "vitest";
import {
  StreamEngine,
  FakeStreamTransport,
  type StreamTimers,
} from "../src/stream/engine.js";
import type { StreamRenderer } from "../src/stream/types.js";

/** A controllable timer + clock so frames can be stepped deterministically. */
function harness() {
  let cb: (() => void) | null = null;
  let cleared = false;
  const timers: StreamTimers = {
    set: (fn) => {
      cb = fn;
      return 1;
    },
    clear: () => {
      cleared = true;
      cb = null;
    },
  };
  let t = 0;
  return {
    timers,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    tick: () => cb?.(),
    hasTimer: () => cb != null,
    wasCleared: () => cleared,
  };
}

/** A renderer that reports the elapsed time it was asked for, so we can assert the clock. */
const clockRenderer: StreamRenderer = {
  frame: (tMs) => [{ id: "a", r: tMs, g: 0, b: 0 }],
};

describe("StreamEngine", () => {
  it("clamps fps to a sane frame interval", () => {
    const mk = (fps: number) =>
      new StreamEngine(new FakeStreamTransport(), { fps }).frameIntervalMs;
    expect(mk(25)).toBe(40);
    expect(mk(100)).toBe(17); // clamped to 60 fps
    expect(mk(0)).toBe(1000); // clamped to 1 fps
  });

  it("emits the t=0 frame immediately on play", () => {
    const h = harness();
    const transport = new FakeStreamTransport();
    const engine = new StreamEngine(transport, {
      timers: h.timers,
      now: h.now,
    });
    engine.play(clockRenderer);
    expect(transport.frames).toHaveLength(1);
    expect(transport.frames[0]).toEqual([{ id: "a", r: 0, g: 0, b: 0 }]);
    expect(engine.isPlaying).toBe(true);
  });

  it("streams a frame per tick with an advancing clock", () => {
    const h = harness();
    const transport = new FakeStreamTransport();
    const engine = new StreamEngine(transport, {
      timers: h.timers,
      now: h.now,
    });
    engine.play(clockRenderer);
    h.advance(40);
    h.tick();
    h.advance(40);
    h.tick();
    expect(transport.frames.map((f) => f[0]!.r)).toEqual([0, 40, 80]);
  });

  it("stop() halts the clock and closes the transport", () => {
    const h = harness();
    const transport = new FakeStreamTransport();
    const engine = new StreamEngine(transport, {
      timers: h.timers,
      now: h.now,
    });
    engine.play(clockRenderer);
    engine.stop();
    expect(engine.isPlaying).toBe(false);
    expect(h.wasCleared()).toBe(true);
    // Closed transport ignores any late frame.
    transport.send([{ id: "a", r: 9, g: 9, b: 9 }]);
    expect(transport.frames).toHaveLength(1);
  });

  it("a throwing transport doesn't crash the loop (always-on safety)", () => {
    const h = harness();
    let sends = 0;
    const throwing = {
      send: () => {
        sends++;
        throw new Error("network hiccup");
      },
      close: () => {},
    };
    const engine = new StreamEngine(throwing, { timers: h.timers, now: h.now });
    // The immediate frame and subsequent ticks must all be swallowed, not thrown.
    expect(() => engine.play(clockRenderer)).not.toThrow();
    h.advance(40);
    expect(() => h.tick()).not.toThrow();
    expect(sends).toBe(2); // it kept trying — the throw didn't wedge the loop
  });

  it("play() again swaps the renderer and restarts the clock", () => {
    const h = harness();
    const transport = new FakeStreamTransport();
    const engine = new StreamEngine(transport, {
      timers: h.timers,
      now: h.now,
    });
    engine.play(clockRenderer);
    h.advance(1000);
    engine.play({ frame: (tMs) => [{ id: "b", r: 0, g: tMs, b: 0 }] });
    // Restarted: the immediate frame is measured from the new start (t=0), not 1000.
    expect(transport.frames.at(-1)).toEqual([{ id: "b", r: 0, g: 0, b: 0 }]);
  });
});
