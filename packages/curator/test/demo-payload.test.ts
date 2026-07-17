import { describe, it, expect } from "vitest";
import { makeAsset } from "./helpers.js";
import { buildPalettePayload, DemoNotReadyError } from "../src/demo/payload.js";

describe("buildPalettePayload", () => {
  it("maps an album's palette + pattern into a Conductor PalettePayload", () => {
    const asset = makeAsset("abc12345", "Purple Rain", "Prince");
    const p = buildPalettePayload(asset);

    expect(p.version).toBe(1);
    expect(p.source).toMatchObject({
      type: "album",
      name: "Purple Rain",
      artist: "Prince",
    });
    // fakePayload's palette: #4B0082 (primary), #FFD700 (secondary); pattern: crossfade.
    expect(p.palette.colors[0]).toMatchObject({
      hex: "#4B0082",
      role: "primary",
    });
    expect(p.pattern.type).toBe("crossfade");
    expect(p.pattern.params).toMatchObject({
      transitionMs: 8000,
      holdMs: 30000,
    });
  });

  it("throws DemoNotReadyError when the album has no palette yet", () => {
    const asset = makeAsset("abc12345");
    delete (asset as { palette?: unknown }).palette;
    expect(() => buildPalettePayload(asset)).toThrow(DemoNotReadyError);
  });

  it("throws when the album has no pattern yet", () => {
    const asset = makeAsset("abc12345");
    delete (asset as { pattern?: unknown }).pattern;
    expect(() => buildPalettePayload(asset)).toThrow(/pattern/i);
  });
});
