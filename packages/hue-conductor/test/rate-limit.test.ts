import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/playback/rate-limit.js";

describe("RateLimiter", () => {
  it("allows a burst up to capacity, then drops until the bucket refills", () => {
    let t = 0;
    const rl = new RateLimiter(8, 4, () => t); // 8/sec sustained, burst of 4

    // Full bucket → 4 back-to-back succeed, the 5th is dropped.
    expect([0, 1, 2, 3].map(() => rl.tryTake("light-a"))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(rl.tryTake("light-a")).toBe(false);

    // After 250ms, 8/sec refills 2 tokens → two more succeed, then dry again.
    t += 250;
    expect(rl.tryTake("light-a")).toBe(true);
    expect(rl.tryTake("light-a")).toBe(true);
    expect(rl.tryTake("light-a")).toBe(false);
  });

  it("meters each key independently", () => {
    let t = 0;
    const rl = new RateLimiter(8, 1, () => t); // capacity 1: one command, then throttle
    expect(rl.tryTake("a")).toBe(true);
    expect(rl.tryTake("a")).toBe(false);
    // A different light is unaffected.
    expect(rl.tryTake("b")).toBe(true);
  });
});
