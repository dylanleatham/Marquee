// Golden tests: run generatePalette over the fixture album covers and compare to committed
// reference JSON. Skips entirely until you drop JPGs into fixtures/artwork/.
//
// First run for a cover (or `pnpm --filter @marquee/palette-press update-goldens`) writes the
// golden; commit it after a human eyeballs the palette. Later runs fail on any drift, which a
// reviewer then accepts (regenerate) or investigates.
import { describe, it, expect } from "vitest";
import {
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { generatePalette, type GeneratedPalettePayload } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const artworkDir = join(here, "..", "..", "..", "fixtures", "artwork");
const goldenDir = join(here, "..", "..", "..", "fixtures", "palettes");

// Golden palettes run locally (dev machine + pre-push), where you review them, but are
// skipped in CI: node-vibrant decodes via sharp, whose platform-specific binaries aren't
// guaranteed to quantize bit-identically across OSes. The deterministic pure-logic + property
// tests are the cross-platform regression guard; goldens catch *subjective* drift locally.
const skip = process.env.CI ? true : !existsSync(artworkDir);
const jpgs =
  !skip && existsSync(artworkDir)
    ? readdirSync(artworkDir)
        .filter((f) => /\.jpe?g$/i.test(f))
        .sort()
    : [];

// meta.generatedAt is a timestamp — compare only the deterministic parts.
const stable = (p: GeneratedPalettePayload) => {
  const { meta: _meta, ...rest } = p;
  return rest;
};

describe.skipIf(skip || jpgs.length === 0)("golden palettes", () => {
  for (const jpg of jpgs) {
    const curatorId = basename(jpg).replace(/\.jpe?g$/i, "");
    it(`${jpg} matches its golden`, async () => {
      const art = readFileSync(join(artworkDir, jpg));
      const payload = stable(
        await generatePalette(art, { curatorId, name: curatorId }),
      );
      const goldenPath = join(goldenDir, `${curatorId}.golden.json`);

      if (process.env.UPDATE_GOLDENS === "1" || !existsSync(goldenPath)) {
        mkdirSync(goldenDir, { recursive: true });
        writeFileSync(goldenPath, JSON.stringify(payload, null, 2) + "\n");
      }
      const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
      expect(payload).toEqual(golden);
    });
  }
});
