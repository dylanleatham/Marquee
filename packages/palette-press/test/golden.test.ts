// Golden tests: run generatePalette over the fixture covers and compare to committed reference JSON.
// Two sources (ADR 0095): the committed synthetic stand-ins in fixtures/synthetic-covers/, which
// always run (asserted below), and any real album covers dropped into the gitignored
// fixtures/artwork/ locally. A cover with no committed golden fails; it is never auto-written.
//
// Comparison is TOLERANT, not byte-exact (see palette-press-spec §10): the structural parts
// that define the experience — color count, roles, insufficient+reason, pattern, source —
// must match exactly, but each color is compared to its golden by ΔE. node-vibrant decodes
// via Jimp (pure JS), so this is deterministic across platforms and exact would pass too —
// ΔE tolerance is a deliberate choice so goldens fail on a *meaningful* experience change
// (a primary flipping purple→orange is ΔE 50+), not a trivial threshold-tweak nudge.
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
const coverDirs = ["synthetic-covers", "artwork"].map((d) =>
  join(here, "..", "..", "..", "fixtures", d),
);
const goldenDir = join(here, "..", "..", "..", "fixtures", "palettes");

const MAX_COLOR_DELTA_E = 12; // tolerate OS jitter; catch dramatic shifts

const jpgs = coverDirs.flatMap((dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.jpe?g$/i.test(f))
        .sort()
        .map((f) => join(dir, f))
    : [],
);

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

describe("golden palettes", () => {
  // The synthetic covers are committed, so an empty list means the path broke — and a suite that
  // silently collects nothing would pass green in CI while testing no palette at all.
  it("finds the committed synthetic covers", () => {
    expect(jpgs.filter((j) => j.startsWith(coverDirs[0]!)).length).toBe(6);
  });

  for (const jpg of jpgs) {
    const curatorId = basename(jpg).replace(/\.jpe?g$/i, "");
    it(`${basename(jpg)} matches its golden`, async () => {
      const art = readFileSync(jpg);
      const payload = stable(
        await generatePalette(art, { curatorId, name: curatorId }),
      );
      const goldenPath = join(goldenDir, `${curatorId}.golden.json`);

      // Goldens are written only on request. Writing a missing one and then comparing against it
      // would pass by construction — a cover committed without its golden would test nothing.
      if (process.env.UPDATE_GOLDENS === "1") {
        mkdirSync(goldenDir, { recursive: true });
        writeFileSync(goldenPath, JSON.stringify(payload, null, 2) + "\n");
      }
      expect(
        existsSync(goldenPath),
        `no golden for ${curatorId} — run \`pnpm --filter @marquee/palette-press update-goldens\` and review the diff`,
      ).toBe(true);
      expectMatchesGolden(
        payload,
        JSON.parse(readFileSync(goldenPath, "utf8")),
      );
    });
  }
});
