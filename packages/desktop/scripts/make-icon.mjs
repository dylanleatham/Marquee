// Generate the app icon (build/icon.png): the Marquee mark in warm paper, centred on a rounded
// near-black tile. It replaces a procedurally-drawn amber bulb that stood in until the real logo
// existed ([ADR 0091](../../../docs/adrs/0091-the-app-icon-and-the-masthead-mark-are-the-logo.md),
// superseding the icon note in ADR 0008).
//
// The mark is thin line art, so the tile is not decoration: at the 24px and 16px sizes Windows uses
// in the taskbar and the title bar the strokes blur together, and the tile is what keeps the icon
// present against both a dark and a light taskbar.
//
// Pure Node, no image libraries: this parses the SVG's path data, flattens the curves and fills them
// itself, then encodes the PNG via zlib. electron-builder converts the 512px PNG into the Windows
// .ico. `renderIconPng()` is exported (and unit-tested); the file writes only when run directly.
import zlib from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// One copy of the mark, shared with the Curator masthead — a second copy here would be a second
// thing to remember to update, and the two would drift (ADR 0091). Exported so the test asserts
// against the path the generator actually reads, rather than a second spelling of it.
export const MARK_SVG = resolve(
  HERE,
  "..",
  "..",
  "curator",
  "ui",
  "src",
  "assets",
  "marquee-mark.svg",
);

/** Where the generated icon lands — electron-builder's `win.icon`, and the dev-run window icon. */
export const ICON_PNG = resolve(HERE, "..", "build", "icon.png");

const N = 512; // output size — electron-builder's minimum for a Windows .ico
const SUB = 8; // subsample rows per pixel; horizontal coverage is exact, so this is the only axis
const INSET = 0.8; // fraction of the tile the mark spans on its longer axis
const TILE_HALF = 0.46; // rounded-square half-extent, in normalized units
const TILE_RADIUS = 0.14; // its corner radius, same units

const INK = [0x17, 0x15, 0x0f]; // the tile — Pressing Plant `--pp-ink`
const PAPER = [0xf2, 0xef, 0xe8]; // the mark — `--pp-paper`

// --- SVG path rasterizing -------------------------------------------------------------------

/** The `d` of every `<path>` in an SVG, in document order. */
export function parsePaths(svg) {
  return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Flatten one path's `d` into closed polygons. Only M/L/C/Z appear in our mark (it is traced
 * outlines, so every stroke is already a filled shape); anything else is a hard error rather than a
 * silent hole in the icon.
 */
export function flatten(d, tol = 0.05) {
  // Tokenize *any* letter, not just the four we handle. Matching only /[MLCZ]/ would drop an `A`
  // or a `Q` on the floor and then read its arguments as coordinates for whatever command came
  // before — a mangled shape instead of the error below. Numbers are tried at every position too,
  // so exponent notation (`1e-5`) still lexes as one token rather than a number, an `e` and a
  // number.
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const polys = [];
  let poly = null;
  let x = 0;
  let y = 0;
  let i = 0;
  let cmd = null;
  const num = () => parseFloat(toks[i++]);
  const cubic = (p0, c1, c2, p1) => {
    // Segment count from the control polygon's length — cheap, and comfortably conservative for a
    // shape this size. Capped so a pathological curve can't stall the build.
    const len =
      Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) +
      Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) +
      Math.hypot(p1[0] - c2[0], p1[1] - c2[1]);
    const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tol))));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      poly.push([
        u * u * u * p0[0] +
          3 * u * u * t * c1[0] +
          3 * u * t * t * c2[0] +
          t * t * t * p1[0],
        u * u * u * p0[1] +
          3 * u * u * t * c1[1] +
          3 * u * t * t * c2[1] +
          t * t * t * p1[1],
      ]);
    }
  };

  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) {
      // Absolute only, and only these four. Upper-casing whatever turned up would draw a relative
      // `c` as an absolute `C` — a wrong shape that still renders, which is the worst kind. Our
      // mark is normalized to absolute M/L/C/Z on the way in; anything else is a bad input, not a
      // case to guess at.
      if (!["M", "L", "C", "Z"].includes(toks[i]))
        throw new Error(`make-icon: unsupported path command "${toks[i]}"`);
      cmd = toks[i++];
    }
    if (cmd === "M") {
      x = num();
      y = num();
      poly = [[x, y]];
      polys.push(poly);
      cmd = "L"; // repeated coordinate pairs after an M are implicit linetos
    } else if (cmd === "L") {
      x = num();
      y = num();
      poly.push([x, y]);
    } else if (cmd === "C") {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const p = [num(), num()];
      cubic([x, y], c1, c2, p);
      [x, y] = p;
    } else if (cmd === "Z") {
      poly = null;
    } else {
      // Coordinates before any command at all.
      throw new Error(
        `make-icon: path data starts with "${toks[i]}", not a command`,
      );
    }
  }
  return polys.filter((p) => p.length > 2);
}

/**
 * Coverage mask (0..1 per pixel) for `paths` scaled by `scale` and shifted by `offX`/`offY` into an
 * `N`×`N` grid. Each path fills by the nonzero rule — that is what makes the counters in the mark
 * (the disc's open middle, the gaps in the grid) holes rather than blots — and the paths are then
 * unioned, so an overlap between two of them can never cancel out.
 */
export function rasterize(paths, scale, offX, offY) {
  const edges = paths.map((d) => {
    const e = [];
    for (const poly of flatten(d)) {
      const pts = poly.map(([px, py]) => [
        px * scale + offX,
        py * scale + offY,
      ]);
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        // Horizontal edges never cross a sample row; dropping them keeps the winding sum honest.
        if (a[1] !== b[1])
          e.push(
            a[1] < b[1]
              ? [a[0], a[1], b[0], b[1], 1]
              : [b[0], b[1], a[0], a[1], -1],
          );
      }
    }
    return e;
  });

  const cov = new Float32Array(N * N);
  const spans = [];
  for (let row = 0; row < N; row++) {
    for (let s = 0; s < SUB; s++) {
      const sy = row + (s + 0.5) / SUB;
      spans.length = 0;
      for (const e of edges) {
        const xs = [];
        for (const [x0, y0, x1, y1, w] of e)
          if (sy >= y0 && sy < y1)
            xs.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), w]);
        xs.sort((a, b) => a[0] - b[0]);
        let wind = 0;
        let startX = 0;
        for (const [xv, w] of xs) {
          const was = wind;
          wind += w;
          if (was === 0 && wind !== 0) startX = xv;
          else if (was !== 0 && wind === 0) spans.push([startX, xv]);
        }
      }
      if (!spans.length) continue;

      // Union the paths' spans, then add each merged span's exact horizontal coverage.
      spans.sort((a, b) => a[0] - b[0]);
      let [lo, hi] = spans[0];
      const flush = () => {
        const a = Math.max(0, lo);
        const b = Math.min(N, hi);
        if (b <= a) return;
        const base = row * N;
        for (let px = Math.floor(a); px < Math.ceil(b); px++)
          cov[base + px] += (Math.min(b, px + 1) - Math.max(a, px)) / SUB;
      };
      for (let k = 1; k < spans.length; k++) {
        if (spans[k][0] > hi) {
          flush();
          [lo, hi] = spans[k];
        } else if (spans[k][1] > hi) hi = spans[k][1];
      }
      flush();
    }
  }
  for (let k = 0; k < cov.length; k++) if (cov[k] > 1) cov[k] = 1;
  return cov;
}

/** Signed distance to a rounded square centred at 0.5 in normalized units. Negative inside. */
function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    r
  );
}

// --- minimal PNG encode (RGBA, filter 0) ------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};

/** Render the icon and return it as an encoded PNG buffer (512×512 RGBA). */
export function renderIconPng() {
  const svg = readFileSync(MARK_SVG, "utf8");
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!viewBox) throw new Error(`make-icon: no viewBox in ${MARK_SVG}`);
  const markW = Number(viewBox[1]);
  const markH = Number(viewBox[2]);

  // Fit the mark inside the inset box and centre it — it is taller than it is wide, so which axis
  // binds is decided here rather than assumed.
  const scale = Math.min((N * INSET) / markW, (N * INSET) / markH);
  const cov = rasterize(
    parsePaths(svg),
    scale,
    (N - markW * scale) / 2,
    (N - markH * scale) / 2,
  );

  const out = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Tile alpha, supersampled both ways so the rounded corners are clean.
      let tile = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++)
          if (
            sdRoundRect(
              (x + (sx + 0.5) / 4) / N,
              (y + (sy + 0.5) / 4) / N,
              TILE_HALF,
              TILE_RADIUS,
            ) < 0
          )
            tile++;

      const ta = tile / 16;
      const m = cov[y * N + x];
      const a = ta + m * (1 - ta); // the mark paints over the tile, and past its edge if it ever ran over
      const i = (y * N + x) * 4;
      for (let k = 0; k < 3; k++)
        out[i + k] =
          a > 0 ? Math.round((INK[k] * ta * (1 - m) + PAPER[k] * m) / a) : 0;
      out[i + 3] = Math.round(a * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++)
    out.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Write only when run directly (`node scripts/make-icon.mjs`), not when imported by the test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const png = renderIconPng();
  mkdirSync(dirname(ICON_PNG), { recursive: true });
  writeFileSync(ICON_PNG, png);
  console.log(`✓ wrote build/icon.png (${N}×${N}, ${png.length} bytes)`);
}
