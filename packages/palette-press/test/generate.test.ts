import { describe, it, expect } from "vitest";
import { generatePalette } from "../src/generate.js";

describe("generatePalette", () => {
  it("throws when curatorId is missing (before touching the image)", async () => {
    // @ts-expect-error — intentionally invalid metadata
    await expect(generatePalette(Buffer.from([]), {})).rejects.toThrow(
      /curatorId is required/,
    );
  });

  it("throws on unreadable image bytes", async () => {
    await expect(
      generatePalette(Buffer.from([1, 2, 3]), { curatorId: "abcd1234" }),
    ).rejects.toThrow(/unreadable image/i);
  });
});
