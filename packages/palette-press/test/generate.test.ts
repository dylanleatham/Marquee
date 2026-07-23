import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

// Entry-point wiring for audioFeatures (ADR 0022): pattern.test.ts exercises selectDefaultPattern in
// isolation, but these assert generatePalette actually threads metadata.audioFeatures into *both* the
// pattern choice and the echoed meta. Uses the Purple Rain fixture (a sufficient, vivid palette that
// rotates by default), skipping if the art isn't present.
const here = dirname(fileURLToPath(import.meta.url));
const purpleRain = join(
  here,
  "..",
  "..",
  "..",
  "fixtures",
  "artwork",
  "purple-rain.jpg",
);

describe.skipIf(!existsSync(purpleRain))(
  "generatePalette — audioFeatures passthrough",
  () => {
    const art = () => readFileSync(purpleRain);

    it("omits meta.audioFeatures and lets the palette drive the pattern by default", async () => {
      const payload = await generatePalette(art(), {
        curatorId: "purple-rain",
      });
      expect(payload.meta?.audioFeatures).toBeUndefined();
      // Vivid cover → the palette-derived read earns motion.
      expect(payload.pattern.type).toBe("rotate");
    });

    it("threads audioFeatures into both the pattern choice and meta", async () => {
      const audioFeatures = { energy: 0.1, tempo: 128 };
      const payload = await generatePalette(art(), {
        curatorId: "purple-rain",
        audioFeatures,
      });
      // Echoed onto the payload...
      expect(payload.meta?.audioFeatures).toEqual(audioFeatures);
      // ...and it reached selection: a low energy override suppresses the default motion.
      expect(payload.pattern.type).toBe("crossfade");
    });
  },
);
