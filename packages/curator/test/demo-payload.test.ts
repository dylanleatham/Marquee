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

  // ADR 0035: a streaming override must not cost the album its derived pattern, because that pattern
  // is what plays on a room with no entertainment area.
  describe("streaming override", () => {
    it("carries the effect alongside the derived pattern, not instead of it", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "aurora";
      const p = buildPalettePayload(asset);
      expect(p.streaming).toEqual({ effect: "aurora" });
      expect(p.pattern.type).toBe("crossfade"); // untouched — the fallback
    });

    it("emits no streaming block for an album that hasn't been overridden", () => {
      // The default for every album: Palette Press never selects a streaming effect.
      expect(
        buildPalettePayload(makeAsset("abc12345")).streaming,
      ).toBeUndefined();
    });

    it.each(["aurora", "shimmer", "wave"] as const)("accepts %s", (effect) => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = effect;
      expect(buildPalettePayload(asset).streaming).toEqual({ effect });
    });

    it("drops an unrecognized override rather than passing it downstream", () => {
      // Same best-effort posture as the role/pattern-type coercion: a bad value degrades to the
      // derived pattern instead of sending Conductor something it can't render.
      const asset = makeAsset("abc12345");
      (asset as { patternOverride?: unknown }).patternOverride = "disco";
      const p = buildPalettePayload(asset);
      expect(p.streaming).toBeUndefined();
      expect(p.pattern.type).toBe("crossfade");
    });

    it("carries tuning through to the payload (ADR 0036)", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "aurora";
      asset.patternOverrideParams = { speed: 0.2 };
      expect(buildPalettePayload(asset).streaming).toEqual({
        effect: "aurora",
        params: { speed: 0.2 },
      });
    });

    it("omits the params key entirely for an untuned album", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "aurora";
      asset.patternOverrideParams = {};
      expect(buildPalettePayload(asset).streaming).toEqual({
        effect: "aurora",
      });
    });

    it("treats null as no override", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = null;
      expect(buildPalettePayload(asset).streaming).toBeUndefined();
    });
  });

  // ADR 0039: a CLIP override *is* the pattern. Every bridge speaks CLIP, so there's nothing to fall
  // back to and no reason to carry a second answer the runtime would have to choose between.
  describe("CLIP override", () => {
    it("replaces the derived pattern in the payload", () => {
      const asset = makeAsset("abc12345"); // derives crossfade
      asset.patternOverride = "rotate";
      const p = buildPalettePayload(asset);
      expect(p.pattern.type).toBe("rotate");
      expect(p.streaming).toBeUndefined();
    });

    it("leaves the stored asset's derived pattern alone", () => {
      // The whole point of storing the override beside `pattern`: picking Auto again is a delete,
      // and a palette regeneration re-derives underneath it.
      const asset = makeAsset("abc12345");
      asset.patternOverride = "rotate";
      buildPalettePayload(asset);
      expect(asset.pattern?.type).toBe("crossfade");
    });

    it("resolves an untouched override to the complete params the contract requires", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "rotate";
      expect(buildPalettePayload(asset).pattern.params).toEqual({
        intervalMs: 1200,
        direction: "forward",
      });
    });

    it("applies the human's tuning over those defaults", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "pulse";
      asset.patternOverrideParams = { periodMs: 800 };
      expect(buildPalettePayload(asset).pattern.params).toEqual({
        periodMs: 800,
        minBrightness: 40,
        maxBrightness: 100,
      });
    });

    it("does not inherit the derived pattern's params when the type matches", () => {
      // ADR 0039: the spec default is *the* default, so an override means the same thing whatever
      // it displaced. This album derives crossfade at 8000/30000 — and the spec agrees on both, so
      // the interesting half is that a tuned knob wins and the untuned one is the spec's, not the
      // album's.
      const asset = makeAsset("abc12345");
      asset.pattern = {
        type: "crossfade",
        params: { transitionMs: 1234, holdMs: 5678 },
        handEdited: false,
      };
      asset.patternOverride = "crossfade";
      expect(buildPalettePayload(asset).pattern.params).toEqual({
        transitionMs: 8000,
        holdMs: 30000,
      });
    });

    it("carries static as an empty param set", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "static";
      const p = buildPalettePayload(asset);
      expect(p.pattern).toEqual({ type: "static", params: {} });
    });
  });

  // ADR 0039's migration: Conductor reads the synced asset store directly (ADR 0019), so an album
  // last saved under ADR 0035's field names must still play what its owner chose.
  describe("legacy streamingEffect fields", () => {
    it("reads a pre-rename opt-in as an override", () => {
      const asset = makeAsset("abc12345");
      (asset as { streamingEffect?: unknown }).streamingEffect = "shimmer";
      (asset as { streamingParams?: unknown }).streamingParams = { speed: 3 };
      expect(buildPalettePayload(asset).streaming).toEqual({
        effect: "shimmer",
        params: { speed: 3 },
      });
    });

    it("prefers the new field when both are somehow present", () => {
      const asset = makeAsset("abc12345");
      asset.patternOverride = "wave";
      (asset as { streamingEffect?: unknown }).streamingEffect = "shimmer";
      expect(buildPalettePayload(asset).streaming).toEqual({ effect: "wave" });
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
