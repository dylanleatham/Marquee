// Golden tests: run generatePalette over the fixture album covers and compare to committed
// reference JSON. Skips only if no artwork has been dropped into fixtures/artwork/.
//
// Comparison is TOLERANT, not byte-exact (see palette-press-spec §10): the structural parts
// that define the experience — color count, roles, insufficient+reason, pattern, source —
// must match exactly, but each color is compared to its golden by ΔE, absorbing the small
// cross-platform quantization jitter from sharp's per-OS binaries while still catching
// dramatic changes (a primary flipping purple→orange is ΔE 50+). That's why these run in CI.
//
// Regenerate after an intentional algorithm change: `pnpm --filter @marquee/palette-press
// update-goldens`, then a human reviews the diff before committing.
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
import {
  generatePalette,
  deltaE,
  type GeneratedPalettePayload,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const artworkDir = join(here, "..", "..", "..", "fixtures", "artwork");
const goldenDir = join(here, "..", "..", "..", "fixtures", "palettes");

const MAX_COLOR_DELTA_E = 12; // tolerate OS jitter; catch dramatic shifts

const jpgs = existsSync(artworkDir)
  ? readdirSync(artworkDir)
      .filter((f) => /\.jpe?g$/i.test(f))
      .sort()
  : [];

// meta.generatedAt is a timestamp — exclude it from comparison.
const stable = (p: GeneratedPalettePayload) => {
  const { meta: _meta, ...rest } = p;
  return rest;
};

const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

type Payload = ReturnType<typeof stable>;

function expectMatchesGolden(payload: Payload, golden: Payload) {
  // Structure that defines the experience — exact.
  expect(payload.source).toEqual(golden.source);
  expect(payload.pattern).toEqual(golden.pattern);
  expect(Boolean(payload.palette.insufficient)).toBe(
    Boolean(golden.palette.insufficient),
  );
  expect(payload.palette.reason).toBe(golden.palette.reason);
  expect(payload.palette.colors.length).toBe(golden.palette.colors.length);
  // Colors — tolerant by ΔE, but roles must line up.
  payload.palette.colors.forEach((c, i) => {
    const g = golden.palette.colors[i]!;
    expect(c.role).toBe(g.role);
    const d = deltaE(hexToRgb(c.hex), hexToRgb(g.hex));
    expect(
      d,
      `color ${i} ${c.hex} vs golden ${g.hex} ΔE=${d.toFixed(1)}`,
    ).toBeLessThan(MAX_COLOR_DELTA_E);
  });
}

describe.skipIf(jpgs.length === 0)("golden palettes", () => {
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
      expectMatchesGolden(
        payload,
        JSON.parse(readFileSync(goldenPath, "utf8")),
      );
    });
  }
});
