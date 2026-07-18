import { describe, it, expect } from "vitest";
import zlib from "node:zlib";

// Imported via a variable so tsc doesn't try to type the plain-JS .mjs generator script.
const modPath = "../scripts/make-icon.mjs";

/** Decode our filter-0 RGBA PNG: parse IHDR, inflate IDAT, index raw scanlines (skip filter byte). */
function decode(png: Buffer) {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const idats: Buffer[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("ascii");
    if (type === "IDAT") idats.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * 4;
  const px = (x: number, y: number) => {
    const i = y * (stride + 1) + 1 + x * 4; // +1 skips the per-row filter byte (0 = none)
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]] as number[];
  };
  return { w, h, px };
}

describe("app icon", () => {
  it("renders a valid 512×512 PNG: lit amber bulb at center, transparent corner", async () => {
    const { renderIconPng } = (await import(modPath)) as {
      renderIconPng: () => Buffer;
    };
    const png = renderIconPng();

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG sig
    const { w, h, px } = decode(png);
    expect([w, h]).toEqual([512, 512]);

    // Center = the lit bulb: opaque, warm amber (high R, mid G, low B).
    const [r, g, b, a] = px(256, 256);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(140);

    // A rounded corner is outside the shape → fully transparent.
    expect(px(4, 4)[3]).toBe(0);
  });
});
