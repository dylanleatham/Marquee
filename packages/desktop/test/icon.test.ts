// The app icon (ADR 0091): the Marquee mark in paper, on a rounded ink tile. The generator parses
// and fills the shared mark SVG itself, so what is worth pinning here is not "some pixel is light"
// but that the fill behaved like an outline — the mark's counters have to stay open, and a broken
// winding rule would quietly hand us a solid paper disc that still passes a naive centre check.
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

// Rendering is ~1.5s of scanline filling; every case below reads the same image, so do it once.
let cached: Promise<Buffer> | null = null;
const render = () =>
  (cached ??= (async () => {
    const { renderIconPng } = (await import(modPath)) as {
      renderIconPng: () => Buffer;
    };
    return renderIconPng();
  })());

describe("app icon", () => {
  it("renders a valid 512×512 PNG on a rounded tile", async () => {
    const png = await render();
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG sig

    const { w, h, px } = decode(png);
    expect([w, h]).toEqual([512, 512]);

    // A rounded corner is outside the tile → fully transparent. electron-builder needs the 512px
    // source; anything smaller is rejected when it builds the .ico.
    expect(px(4, 4)[3]).toBe(0);

    // Well inside the tile but clear of the mark: opaque ink, the darkest thing in the icon.
    const tile = px(40, 256);
    expect(tile[3]).toBe(255);
    expect(Math.max(tile[0]!, tile[1]!, tile[2]!)).toBeLessThan(60);
  });

  it("draws the mark as line art, not a filled disc", async () => {
    const { px } = decode(await render());

    // On a stroke — the tonearm crosses the icon's centre.
    expect(px(256, 256)[0]).toBeGreaterThan(200);

    // Inside the disc's outline but between its strokes. This is the assertion that matters. The
    // mark is a traced outline: its inside is a hole only because the inner contour winds opposite
    // to the outer one. Fill each subpath on its own and union them — the easy way to get this
    // wrong — and the disc comes out a solid paper blob. Verified by doing exactly that: this line
    // reads 242 instead of 23.
    expect(px(220, 300)[0]).toBeLessThan(60);
  });

  it("gives the mark a sane share of the tile", async () => {
    const { w, px } = decode(await render());
    let paper = 0;
    let ink = 0;
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const p = px(x, y);
        if (p[3]! < 8) continue;
        if (p[0]! > 200) paper++;
        else if (p[0]! < 60) ink++;
      }
    // Bounds either side of the ~18% the mark actually covers: too little means it failed to render
    // or shrank to a speck, too much means the strokes bled into each other. Both are invisible in
    // a per-pixel check and obvious at taskbar size.
    const share = paper / (paper + ink);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.35);
  });

  it("is committed in step with the mark it is drawn from", async () => {
    // build/icon.png is a generated file that ships. Change the mark, forget to re-run the
    // generator, and the taskbar quietly keeps the old picture — `pnpm run dist` regenerates it,
    // which is far too late to notice. Nothing in CI runs the generator, so this is the gate.
    //
    // Pixels, not bytes: zlib's output is not guaranteed identical across Node versions, and a
    // byte compare would fail on a version bump that changed nothing anyone can see.
    const { ICON_PNG } = (await import(modPath)) as { ICON_PNG: string };
    const { readFileSync } = await import("node:fs");
    // Read the path the generator writes, not a second spelling of it — otherwise a move leaves
    // this test happily comparing the render against a file nothing ships.
    const committed = readFileSync(ICON_PNG);

    const fresh = decode(await render());
    const onDisk = decode(committed);
    expect([onDisk.w, onDisk.h]).toEqual([fresh.w, fresh.h]);

    let worst = 0;
    for (let y = 0; y < fresh.h; y++)
      for (let x = 0; x < fresh.w; x++) {
        const a = fresh.px(x, y);
        const b = onDisk.px(x, y);
        for (let k = 0; k < 4; k++)
          worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
      }
    // If this fails: pnpm --filter @marquee/desktop icon
    expect(worst).toBe(0);
  });

  it("draws the mark the masthead draws, not a copy of it", async () => {
    // The icon and the Curator masthead read one file (ADR 0091). Asserting on the generator's own
    // MARK_SVG rather than re-spelling the path means a move or a rename surfaces here, as a clear
    // failure, instead of as an icon that quietly stops matching the app.
    const { MARK_SVG } = (await import(modPath)) as { MARK_SVG: string };
    const { readFileSync } = await import("node:fs");

    expect(MARK_SVG.replace(/\\/g, "/")).toContain(
      "curator/ui/src/assets/marquee-mark.svg",
    );
    const svg = readFileSync(MARK_SVG, "utf8");
    // What the generator needs from it: a box to scale into, and no colour of its own.
    expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg).toContain('fill="currentColor"');
  });
});
