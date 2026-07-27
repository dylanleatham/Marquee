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

  // ADR 0035: opting an album into a streaming effect must not cost it the derived pattern, because
  // that pattern is what plays on a room with no entertainment area.
  describe("streaming opt-in", () => {
    it("carries the effect alongside the derived pattern, not instead of it", () => {
      const asset = makeAsset("abc12345");
      asset.streamingEffect = "aurora";
      const p = buildPalettePayload(asset);
      expect(p.streaming).toEqual({ effect: "aurora" });
      expect(p.pattern.type).toBe("crossfade"); // untouched — the fallback
    });

    it("emits no streaming block for an album that hasn't opted in", () => {
      // The default for every album: Palette Press never selects a streaming effect.
      expect(
        buildPalettePayload(makeAsset("abc12345")).streaming,
      ).toBeUndefined();
    });

    it.each(["aurora", "shimmer", "wave"] as const)("accepts %s", (effect) => {
      const asset = makeAsset("abc12345");
      asset.streamingEffect = effect;
      expect(buildPalettePayload(asset).streaming).toEqual({ effect });
    });

    it("drops an unrecognized effect rather than passing it downstream", () => {
      // Same best-effort posture as the role/pattern-type coercion: a bad value degrades to the
      // derived pattern instead of sending Conductor an effect it can't render.
      const asset = makeAsset("abc12345");
      (asset as { streamingEffect?: unknown }).streamingEffect = "disco";
      const p = buildPalettePayload(asset);
      expect(p.streaming).toBeUndefined();
      expect(p.pattern.type).toBe("crossfade");
    });

    it("treats null as not opted in", () => {
      const asset = makeAsset("abc12345");
      asset.streamingEffect = null;
      expect(buildPalettePayload(asset).streaming).toBeUndefined();
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
