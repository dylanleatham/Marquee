// Generates the committed stand-in covers in fixtures/synthetic-covers/ (ADR 0095).
//
// Real album covers are copyrighted, so the repo can't ship them. These images are drawn from
// scratch to reproduce the *colour character* of each real fixture in testing-strategy §3.4 — the
// property Palette Press actually cares about — so the golden and integration tests still exercise
// every hard case in CI. Real covers remain supported locally in fixtures/artwork/ (gitignored).
//
// Deterministic: a seeded PRNG and a fixed JPEG quality, so re-running produces byte-identical
// files. Re-run only when adding a cover, then regenerate goldens:
//   node packages/palette-press/scripts/gen-synthetic-covers.mjs
//   pnpm --filter @marquee/palette-press update-goldens
import jpeg from "jpeg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const QUALITY = 90;
const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "synthetic-covers",
);

// mulberry32 — tiny, seedable, good enough for texture noise.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

/** Render a cover from a per-pixel colour function, with a little grain so it isn't flat. */
function render(seed, grain, pixel) {
  const rand = prng(seed);
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixel(x / SIZE, y / SIZE);
      const n = (rand() - 0.5) * grain;
      const i = (y * SIZE + x) * 4;
      data[i] = clamp(r + n);
      data[i + 1] = clamp(g + n);
      data[i + 2] = clamp(b + n);
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width: SIZE, height: SIZE }, QUALITY).data;
}

const covers = {
  // Obvious dominant colour — the canonical validation case (stands in for Purple Rain).
  // Purple-led, with warm gold and deep-red accents, as the real sleeve has.
  "vivid-purple": render(1, 10, (x, y) => {
    const base = mix([130, 60, 210], [90, 30, 160], y);
    const d = Math.hypot(x - 0.62, y - 0.38);
    if (d < 0.16) return mix([245, 175, 40], base, d / 0.16); // gold glow
    if (y > 0.9) return [150, 20, 30]; // deep-red foreground band
    return base;
  }),
  // Obvious colour, different hue family (stands in for Kind of Blue).
  "vivid-blue": render(2, 10, (x, y) => {
    if (x < 0.3) return [12, 14, 20]; // black side panel
    const base = mix([20, 70, 170], [10, 30, 90], y);
    return y < 0.25 ? mix([60, 170, 220], base, y / 0.25) : base;
  }),
  // Nearly monochrome — challenges the post-processor (stands in for The White Album).
  "near-white": render(3, 4, (x, y) => {
    const embossed = y > 0.7 && y < 0.74 && x > 0.55 && x < 0.9;
    return embossed ? [214, 214, 210] : [244, 243, 240];
  }),
  // Truly monochrome — expect `insufficient` (stands in for the Black Album).
  "mono-black": render(4, 4, (x, y) => {
    const logo = y > 0.8 && y < 0.84 && x > 0.2 && x < 0.8;
    return logo ? [34, 34, 34] : [8, 8, 8];
  }),
  // Muted and complex — the realistic middle case (stands in for Rumours).
  "muted-complex": render(5, 14, (x, y) => {
    const blocks = [
      [150, 120, 95], // warm tan
      [96, 104, 84], // olive
      [178, 160, 140], // beige
      [110, 86, 80], // dusty brown
    ];
    const band = Math.floor(x * 3 + y * 2) % blocks.length;
    return mix(blocks[band], [128, 124, 118], 0.2);
  }),
  // Black-and-white linework — the hardest realistic case (stands in for Unknown Pleasures).
  // Deliberately generic geometry (concentric rings), so it resembles no real sleeve.
  "bw-lines": render(6, 3, (x, y) => {
    const r = Math.hypot(x - 0.5, y - 0.5);
    const ring = r < 0.42 && (r * 60) % 1 < 0.18;
    return ring ? [236, 236, 236] : [6, 6, 6];
  }),
};

mkdirSync(outDir, { recursive: true });
for (const [name, bytes] of Object.entries(covers)) {
  writeFileSync(join(outDir, `${name}.jpg`), bytes);
  console.log(
    `wrote fixtures/synthetic-covers/${name}.jpg (${bytes.length} bytes)`,
  );
}
