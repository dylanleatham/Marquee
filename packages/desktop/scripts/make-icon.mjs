// Generate the app icon (build/icon.png) — a lit amber marquee bulb on the UI's warm near-black,
// matching the brand `●`. Pure Node (no image libs): render at 2× and box-downscale for clean edges,
// then encode PNG via zlib. electron-builder converts this 512px PNG into the Windows .ico.
// `renderIconPng()` is exported (and unit-tested); the file writes it only when run directly.
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const N = 512; // output size
const SS = 2; // supersample factor
const S = N * SS;

const BG = [0x14, 0x11, 0x0f]; // warm near-black (UI --bg)
const AMBER = [0xf5, 0xa6, 0x23]; // marquee bulb (UI --amber)
const CORE = [0xff, 0xe6, 0xb0]; // hot highlight on the bulb

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const smooth = (t) => t * t * (3 - 2 * t);

// Signed distance to a rounded square centered at 0.5 (normalized units). <0 inside.
function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Color + alpha (0..1) for a normalized point. */
function shade(x, y) {
  const inside = sdRoundRect(x, y, 0.44, 0.16) < 0;
  if (!inside) return { rgb: BG, a: 0 };

  let rgb = BG;
  const d = Math.hypot(x - 0.5, y - 0.5);

  // Soft radial glow so the bulb reads as *lit*.
  const glow = Math.pow(clamp(1 - d / 0.46, 0, 1), 1.6) * 0.55;
  rgb = mix(rgb, AMBER, glow);

  // The bulb itself, with a top-left highlight.
  const bulbR = 0.29;
  if (d < bulbR) {
    rgb = AMBER;
    const hd = Math.hypot(x - 0.42, y - 0.42);
    rgb = mix(rgb, CORE, smooth(clamp(1 - hd / 0.22, 0, 1)) * 0.85);
  }
  return { rgb, a: 1 };
}

// --- minimal PNG encode (RGBA, filter 0) ---
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
  // Render at S×S, then average SS×SS blocks down to N×N for anti-aliasing.
  const out = Buffer.alloc(N * N * 4);
  for (let oy = 0; oy < N; oy++) {
    for (let ox = 0; ox < N; ox++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = shade((ox * SS + sx + 0.5) / S, (oy * SS + sy + 0.5) / S);
          r += s.rgb[0] * s.a;
          g += s.rgb[1] * s.a;
          b += s.rgb[2] * s.a;
          a += s.a;
        }
      }
      const i = (oy * N + ox) * 4;
      const av = a / (SS * SS);
      // Un-premultiply so edge pixels keep the right hue against transparency.
      out[i] = av > 0 ? Math.round(r / a) : 0;
      out[i + 1] = av > 0 ? Math.round(g / a) : 0;
      out[i + 2] = av > 0 ? Math.round(b / a) : 0;
      out[i + 3] = Math.round(av * 255);
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
  const buildDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "build",
  );
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "icon.png"), png);
  console.log(`✓ wrote build/icon.png (${N}×${N}, ${png.length} bytes)`);
}
