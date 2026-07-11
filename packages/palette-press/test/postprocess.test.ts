import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { postProcessPalette } from "../src/postprocess.js";
import { rgbToHsv, clampToGamutC, deltaE } from "../src/color.js";
import type { RGB, Palette } from "../src/types.js";

const hexToRgb = (hex: string): RGB => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

describe("postProcessPalette — examples", () => {
  it("keeps three well-separated colors and assigns roles in order", () => {
    const result = postProcessPalette({
      vibrant: [200, 20, 20], // red
      lightVibrant: [20, 200, 20], // green
      muted: [20, 20, 200], // blue
    });
    expect(result.insufficient).toBe(false);
    expect(result.colors.map((c) => c.role)).toEqual([
      "primary",
      "secondary",
      "accent",
    ]);
    expect(result.colors).toHaveLength(3);
  });

  it("boosts a low-saturation (but non-grey) swatch instead of dropping it", () => {
    const result = postProcessPalette({
      vibrant: [130, 120, 120], // s ≈ 0.08 — below floor, above grey
      muted: [20, 20, 200], // a second distinct color so the palette is valid
    }) as Palette;
    expect(result.insufficient).toBe(false);
    const boosted = hexToRgb(result.colors[0]!.hex);
    expect(rgbToHsv(boosted).s).toBeGreaterThan(0.3); // boosted toward 0.4
  });

  it("drops near-grey swatches; all-grey art is insufficient/monochrome", () => {
    const result = postProcessPalette({
      vibrant: [128, 128, 128],
      muted: [130, 130, 130],
    });
    expect(result.insufficient).toBe(true);
    if (result.insufficient) expect(result.reason).toBe("monochrome");
    expect(result.colors).toHaveLength(0);
  });

  it("returns unusable_art when no swatches were extracted", () => {
    const result = postProcessPalette({});
    expect(result).toMatchObject({
      insufficient: true,
      reason: "unusable_art",
      colors: [],
    });
  });

  it("drops a color too close to one already kept (contrast filter)", () => {
    const result = postProcessPalette({
      vibrant: [200, 20, 20], // red — kept
      lightVibrant: [205, 24, 24], // near-identical red — dropped
      muted: [20, 20, 200], // blue — kept
    });
    expect(result.colors).toHaveLength(2);
    expect(result.colors.map((c) => c.role)).toEqual(["primary", "secondary"]);
  });

  it("caps at maxColors", () => {
    const result = postProcessPalette(
      {
        vibrant: [200, 20, 20],
        lightVibrant: [20, 200, 20],
        muted: [20, 20, 200],
      },
      { maxColors: 2 },
    );
    expect(result.colors).toHaveLength(2);
  });

  it("leads with the dominant color among the colorful ones (not a dull high-population bg)", () => {
    // muted brown has the highest population but is dull; the vivid blue should still lead.
    const result = postProcessPalette(
      { muted: [90, 70, 55], vibrant: [20, 60, 200] }, // brown (dull), blue (colorful)
      {},
      { muted: 9000, vibrant: 500 }, // brown dominates by area
    ) as Palette;
    expect(result.insufficient).toBe(false);
    expect(hexToRgb(result.colors[0]!.hex)[2]).toBeGreaterThan(
      hexToRgb(result.colors[0]!.hex)[0],
    ); // primary is blue-ish
  });

  it("flags an all-one-hue palette as monochrome (hue-spread guard)", () => {
    // Four blues at different lightnesses — a single-hue source.
    const result = postProcessPalette({
      vibrant: [40, 90, 200],
      darkVibrant: [20, 45, 100],
      lightMuted: [120, 160, 230],
      darkMuted: [30, 60, 130],
    });
    expect(result.insufficient).toBe(true);
    if (result.insufficient) expect(result.reason).toBe("monochrome");
  });
});

describe("postProcessPalette — invariants (property-based)", () => {
  const rgbArb = fc.tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  );
  const swatchesArb = fc.record(
    {
      vibrant: fc.option(rgbArb, { nil: undefined }),
      lightVibrant: fc.option(rgbArb, { nil: undefined }),
      darkVibrant: fc.option(rgbArb, { nil: undefined }),
      muted: fc.option(rgbArb, { nil: undefined }),
      lightMuted: fc.option(rgbArb, { nil: undefined }),
      darkMuted: fc.option(rgbArb, { nil: undefined }),
    },
    { requiredKeys: [] },
  );

  it("any output palette is Hue-safe, ordered, contrast-separated, and capped", () => {
    fc.assert(
      fc.property(swatchesArb, (swatches) => {
        const minDeltaE = 15;
        const result = postProcessPalette(swatches as Record<string, RGB>, {
          minDeltaE,
          maxColors: 4,
        });

        expect(result.colors.length).toBeLessThanOrEqual(4);
        if (result.insufficient) {
          expect(result.colors.length).toBeLessThanOrEqual(1);
          return;
        }
        expect(result.colors.length).toBeGreaterThanOrEqual(2);

        const rgbs = result.colors.map((c) => hexToRgb(c.hex));
        result.colors.forEach((c, i) => {
          // roles in order
          expect(c.role).toBe(
            i === 0 ? "primary" : i === 1 ? "secondary" : "accent",
          );
          // stored xy is in gamut (idempotent re-clamp)
          expect(clampToGamutC(c.cie_xy).shift).toBeLessThan(1e-3);
          // above saturation/brightness floors (small epsilon for hex rounding)
          const { s, v } = rgbToHsv(rgbs[i]!);
          expect(s).toBeGreaterThanOrEqual(0.15 - 0.03);
          expect(v).toBeGreaterThanOrEqual(0.25 - 0.03);
        });
        // every pair is at least minDeltaE apart (epsilon for hex rounding)
        for (let i = 0; i < rgbs.length; i++) {
          for (let j = i + 1; j < rgbs.length; j++) {
            expect(deltaE(rgbs[i]!, rgbs[j]!)).toBeGreaterThan(minDeltaE - 3);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
