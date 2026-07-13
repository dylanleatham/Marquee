import { describe, it, expect } from "vitest";
import { generateCuratorId, isCuratorId } from "../src/ids.js";

describe("curatorId", () => {
  it("generates 8-char [a-z0-9] ids", () => {
    const id = generateCuratorId(() => false);
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(isCuratorId(id)).toBe(true);
  });

  it("retries past collisions", () => {
    let calls = 0;
    const id = generateCuratorId(() => ++calls <= 2); // first two ids "exist"
    expect(calls).toBe(3);
    expect(isCuratorId(id)).toBe(true);
  });

  it("throws if it can't find a free id", () => {
    expect(() => generateCuratorId(() => true)).toThrow(/unique/i);
  });

  it("rejects malformed ids (incl. uppercase/ambiguous)", () => {
    expect(isCuratorId("TooLong1")).toBe(false);
    expect(isCuratorId("abc")).toBe(false);
    expect(isCuratorId("2k7bxq9m")).toBe(true);
  });
});
