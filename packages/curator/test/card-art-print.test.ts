// The card-art print render (issue #98 / ADR 0042). Before this, `/card-art/print` served the stored
// bytes verbatim under a spec table that promised "300 DPI, standard business-card dimensions", and
// nothing in the suite touched the route at all — the two claims could disagree indefinitely.
//
// The geometry is unit-tested pure (printTarget/coverBox/buildPrintArgs), the orchestration through a
// fake `run`, and the route end-to-end. A final block runs the argv we build through the REAL ffmpeg,
// because "the filtergraph is a plausible string" and "ffmpeg accepts it" are different claims — the
// same gap that shipped the broken normalize in issue #180.
import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import {
  printTarget,
  coverBox,
  buildPrintArgs,
  withPngDpi,
  withJpegDpi,
  renderCardArtPrint,
  PrintError,
  PRINT_DPI,
} from "../src/media/print.js";
import { imageSize } from "../src/media/images.js";
import { ffmpegAvailable, run, VideoError } from "../src/media/video.js";
import {
  makeAsset,
  fakeProber,
  pngBytes,
  pngImage,
  jpegBytes,
} from "./helpers.js";

// Anything that needs the real binary is skipped without it — a local/dev gate, not a CI one, the
// same call video-ffmpeg-integration.test.ts makes.
const hasFfmpeg = ffmpegAvailable();
const itFfmpeg = hasFfmpeg ? it : it.skip;
const describeFfmpeg = hasFfmpeg ? describe : describe.skip;

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-print-")));

/** Seed an album with card art of the given pixel size actually on disk. */
function seed(
  s: AssetStore,
  { width = 1024, height = 1024, id = "prnt0001" } = {},
) {
  const asset = makeAsset(id, "Purple Rain", "Prince");
  asset.cardArt = {
    fileId: id,
    originalFilename: "art.png",
    ext: "png",
    attachedAt: "2026-07-31T00:00:00.000Z",
    resolution: `${width}x${height}`,
    orientation: width >= height ? "landscape" : "portrait",
  };
  s.save(asset);
  mkdirSync(s.paths.cardArt, { recursive: true });
  writeFileSync(s.paths.cardArtFile(id, "png"), pngImage(width, height));
  return id;
}

const curator = (s: AssetStore) =>
  buildServer({ store: s, prober: fakeProber() }).app;

/** Read a PNG's pHYs chunk back as DPI, or null when it carries none. */
function pngDpi(buf: Buffer): number | null {
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    if (buf.toString("ascii", at + 4, at + 8) === "pHYs") {
      const perMetre = buf.readUInt32BE(at + 8);
      const unit = buf.readUInt8(at + 16);
      return unit === 1 ? Math.round(perMetre * 0.0254) : null;
    }
    at += 12 + len;
  }
  return null;
}

describe("printTarget", () => {
  it("is exactly 3.5x2in at 300 DPI for landscape art", () => {
    expect(printTarget({ width: 1600, height: 900 })).toEqual({
      width: 1050,
      height: 600,
    });
  });

  it("turns the card portrait when the art is taller than it is wide", () => {
    expect(printTarget({ width: 900, height: 1600 })).toEqual({
      width: 600,
      height: 1050,
    });
  });

  it("treats a square source as landscape, and an unreadable one too", () => {
    expect(printTarget({ width: 1024, height: 1024 })).toEqual({
      width: 1050,
      height: 600,
    });
    expect(printTarget(null)).toEqual({ width: 1050, height: 600 });
  });

  it("adds 0.125in of bleed on every edge when asked", () => {
    expect(printTarget({ width: 1600, height: 900 }, { bleed: true })).toEqual({
      width: 1125,
      height: 675,
    });
    expect(printTarget({ width: 900, height: 1600 }, { bleed: true })).toEqual({
      width: 675,
      height: 1125,
    });
  });
});

describe("coverBox", () => {
  const target = { width: 1050, height: 600 };

  it("scales a square source up until it covers the card", () => {
    const box = coverBox({ width: 1024, height: 1024 }, target);
    expect(box).toEqual({ width: 1050, height: 1050 });
  });

  it("scales a too-wide source down to the card's height", () => {
    // 3840x1080 is wider than 7:4, so height binds: 600/1080 → 2133x600.
    expect(coverBox({ width: 3840, height: 1080 }, target)).toEqual({
      width: 2133,
      height: 600,
    });
  });

  it("never returns a box smaller than the target on either axis", () => {
    // 1051x600 scales by 600/600 = 1.0 on height and rounds the width back to 1051 — but a source
    // whose rounding lands a pixel *under* the target would make `crop` fail, so both axes clamp.
    for (const source of [
      { width: 1050, height: 600 },
      { width: 1051, height: 600 },
      { width: 999, height: 571 },
      { width: 7, height: 4 },
    ]) {
      const box = coverBox(source, target);
      expect(box.width).toBeGreaterThanOrEqual(target.width);
      expect(box.height).toBeGreaterThanOrEqual(target.height);
    }
  });
});

describe("buildPrintArgs", () => {
  it("scales to cover then centre-crops to the card box", () => {
    const args = buildPrintArgs(
      "/in.png",
      "/out.png",
      { width: 1024, height: 1024 },
      { width: 1050, height: 600 },
    );
    expect(args.join(" ")).toContain(
      "scale=1050:1050:flags=lanczos,crop=1050:600",
    );
    expect(args).toContain("/in.png");
    expect(args[args.length - 1]).toBe("/out.png");
  });

  it("lets ffmpeg compute the cover when the source dimensions are unreadable", () => {
    const args = buildPrintArgs("/in.png", "/out.png", null, {
      width: 1050,
      height: 600,
    });
    expect(args.join(" ")).toContain("force_original_aspect_ratio=increase");
  });

  it("pins the muxer and the codec, so an extensionless temp path still encodes (issue #180)", () => {
    const args = buildPrintArgs("/in.png", "/out.png", null, {
      width: 1050,
      height: 600,
    });
    expect(args).toEqual(expect.arrayContaining(["-f", "image2"]));
    expect(args).toEqual(expect.arrayContaining(["-c:v", "png"]));
  });
});

describe("DPI stamping", () => {
  it("writes 300 DPI into a PNG as a pHYs chunk without disturbing the pixels", () => {
    const src = pngImage(64, 64);
    const out = withPngDpi(src);
    expect(pngDpi(src)).toBeNull();
    expect(pngDpi(out)).toBe(PRINT_DPI);
    expect(imageSize(out, "png")).toEqual({ width: 64, height: 64 });
    // Every original chunk survives; only pHYs is new.
    expect(out.length).toBe(src.length + 21);
    expect(
      out.subarray(out.length - 12).equals(src.subarray(src.length - 12)),
    ).toBe(true);
  });

  it("replaces an existing pHYs rather than appending a second one", () => {
    const once = withPngDpi(pngImage(64, 64), 72);
    const twice = withPngDpi(once, PRINT_DPI);
    expect(pngDpi(twice)).toBe(PRINT_DPI);
    expect(twice.length).toBe(once.length);
  });

  it("refuses to stamp something that isn't a PNG", () => {
    expect(() => withPngDpi(jpegBytes())).toThrow(PrintError);
  });

  it("patches an existing JFIF APP0 density in place", () => {
    const jfif = Buffer.concat([
      Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      ]),
      jpegBytes().subarray(2),
    ]);
    const out = withJpegDpi(jfif);
    expect(out.length).toBe(jfif.length);
    expect(out.readUInt8(13)).toBe(1); // units: dots per inch
    expect(out.readUInt16BE(14)).toBe(PRINT_DPI);
    expect(out.readUInt16BE(16)).toBe(PRINT_DPI);
  });

  it("splices an APP0 in when the JPEG opens with something else", () => {
    // Gemini's JPEGs lead with an Exif APP1, so this is the common path, not the exotic one.
    const exif = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66]),
      jpegBytes().subarray(2),
    ]);
    const out = withJpegDpi(exif);
    expect(out.length).toBe(exif.length + 18);
    expect(out.toString("ascii", 6, 10)).toBe("JFIF");
    expect(out.readUInt16BE(14)).toBe(PRINT_DPI);
    // The APP1 the file already had is still there, just after ours.
    expect(out.readUInt16BE(20)).toBe(0xffe1);
    // Still a readable JPEG of the same dimensions.
    expect(imageSize(out, "jpg")).toEqual(imageSize(exif, "jpg"));
  });
});

describe("renderCardArtPrint", () => {
  const write = (buf: Buffer, name = "art.png") => {
    const file = join(mkdtempSync(join(tmpdir(), "curator-src-")), name);
    writeFileSync(file, buf);
    return file;
  };

  it("skips ffmpeg entirely when the art is already card-sized", async () => {
    const runSpy = vi.fn();
    const out = await renderCardArtPrint(
      { run: runSpy as unknown as typeof run },
      { file: write(pngImage(1050, 600)), ext: "png" },
    );
    expect(runSpy).not.toHaveBeenCalled();
    expect(out.rendered).toBe(false);
    expect(out.target).toEqual({ width: 1050, height: 600 });
    expect(pngDpi(out.bytes)).toBe(PRINT_DPI);
  });

  it("still runs ffmpeg for card-sized art when bleed moves the target", async () => {
    const fakeRun = vi.fn(async (_bin: string, args: string[]) => {
      writeFileSync(args[args.length - 1]!, pngImage(1125, 675));
      return "";
    });
    const out = await renderCardArtPrint(
      { run: fakeRun as unknown as typeof run },
      { file: write(pngImage(1050, 600)), ext: "png", bleed: true },
    );
    expect(fakeRun).toHaveBeenCalledOnce();
    expect(out.rendered).toBe(true);
    expect(out.target).toEqual({ width: 1125, height: 675 });
  });

  it("renders off-size art through ffmpeg and stamps the result", async () => {
    const fakeRun = vi.fn(async (_bin: string, args: string[]) => {
      writeFileSync(args[args.length - 1]!, pngImage(1050, 600));
      return "";
    });
    const out = await renderCardArtPrint(
      { run: fakeRun as unknown as typeof run },
      { file: write(pngImage(1024, 1024)), ext: "png" },
    );
    expect(out.rendered).toBe(true);
    expect(out.contentType).toBe("image/png");
    expect(out.ext).toBe("png");
    expect(pngDpi(out.bytes)).toBe(PRINT_DPI);
    expect(fakeRun.mock.calls[0]![1].join(" ")).toContain("crop=1050:600");
  });

  it("caps the render so a wedged ffmpeg can't hold the request open", async () => {
    const fakeRun = vi.fn(async (_b: string, args: string[]) => {
      writeFileSync(args[args.length - 1]!, pngImage(1050, 600));
      return "";
    });
    await renderCardArtPrint(
      { run: fakeRun as unknown as typeof run },
      { file: write(pngImage(1024, 1024)), ext: "png" },
    );
    expect(fakeRun.mock.calls[0]![2]).toBeGreaterThan(0);
  });

  it("reports a missing ffmpeg as `unavailable`, and cleans up its temp dir", async () => {
    let dest = "";
    const fakeRun = vi.fn(async (_b: string, args: string[]) => {
      dest = args[args.length - 1]!;
      throw new VideoError("Could not run ffmpeg (spawn ENOENT).", {
        binaryUnavailable: true,
      });
    });
    const err = await renderCardArtPrint(
      { run: fakeRun as unknown as typeof run },
      { file: write(pngImage(1024, 1024)), ext: "png" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrintError);
    expect((err as PrintError).kind).toBe("unavailable");
    expect((err as PrintError).message).toMatch(/ffmpeg/);
    expect(existsSync(dest)).toBe(false);
  });

  // The route's 404 depends on this: a missing file must arrive as a raw ENOENT, not wrapped into a
  // PrintError, or "your card art is gone" gets reported as "the print pipeline is broken".
  it("lets a missing source file through as ENOENT rather than wrapping it", async () => {
    const err = await renderCardArtPrint(
      {},
      { file: join(tmpdir(), "marquee-no-such-card-art.png"), ext: "png" },
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PrintError);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("reports ffmpeg rejecting the art as `failed`, not as a missing dependency", async () => {
    const fakeRun = vi.fn(async () => {
      throw new VideoError("ffmpeg exited 1: Invalid data found …");
    });
    const err = await renderCardArtPrint(
      { run: fakeRun as unknown as typeof run },
      { file: write(pngImage(1024, 1024)), ext: "png" },
    ).catch((e: unknown) => e);
    expect((err as PrintError).kind).toBe("failed");
  });
});

describe("GET /card-art/print", () => {
  it("404s when the album has no card art", async () => {
    const s = store();
    s.save(makeAsset("noart001", "Kind of Blue", "Miles Davis"));
    const res = await curator(s).inject({
      method: "GET",
      url: "/api/albums/noart001/card-art/print",
    });
    expect(res.statusCode).toBe(404);
  });

  // There is no existsSync precheck — the ENOENT from opening the file *is* the 404. A precheck
  // would only open a window in which a concurrent `detach-card-art?delete=1` turned this into a
  // render failure (422), which is a wrong answer to "where did my card art go?".
  it("404s when the asset references card art that isn't on disk", async () => {
    const s = store();
    const id = seed(s);
    const { rmSync } = await import("node:fs");
    rmSync(s.paths.cardArtFile(id, "png"));
    const res = await curator(s).inject({
      method: "GET",
      url: `/api/albums/${id}/card-art/print`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports a missing file as not-available, not as a broken render", async () => {
    const s = store();
    const id = seed(s, { width: 1024, height: 1024 }); // off-size: would otherwise take the ffmpeg path
    const { rmSync } = await import("node:fs");
    rmSync(s.paths.cardArtFile(id, "png"));
    const res = await curator(s).inject({
      method: "GET",
      url: `/api/albums/${id}/card-art/print`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not available/i);
  });

  it("serves card-sized art as a 300-DPI download without needing ffmpeg", async () => {
    const s = store();
    const id = seed(s, { width: 1050, height: 600 });
    const res = await curator(s).inject({
      method: "GET",
      url: `/api/albums/${id}/card-art/print`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="${id}-card-print.png"`,
    );
    expect(pngDpi(res.rawPayload)).toBe(PRINT_DPI);
    // This is the whole point of the issue: the bytes are no longer the stored file verbatim.
    expect(
      res.rawPayload.equals(readFileSync(s.paths.cardArtFile(id, "png"))),
    ).toBe(false);
  });

  it("names the bleed download differently so the two don't overwrite each other", async () => {
    const s = store();
    const id = seed(s, { width: 1125, height: 675 });
    const res = await curator(s).inject({
      method: "GET",
      url: `/api/albums/${id}/card-art/print?bleed=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="${id}-card-print-bleed.png"`,
    );
  });

  it("treats any bleed value other than 1 as off", async () => {
    const s = store();
    const id = seed(s, { width: 1050, height: 600 });
    for (const q of ["bleed=0", "bleed=yes", "bleed="]) {
      const res = await curator(s).inject({
        method: "GET",
        url: `/api/albums/${id}/card-art/print?${q}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="${id}-card-print.png"`,
      );
    }
  });

  it("503s when this workstation has no ffmpeg — the art is fine, the pipeline isn't", async () => {
    const s = store();
    const id = seed(s, { width: 1024, height: 1024 }); // off-size, so the ffmpeg branch runs
    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = join(tmpdir(), "marquee-no-such-ffmpeg");
    try {
      const res = await curator(s).inject({
        method: "GET",
        url: `/api/albums/${id}/card-art/print`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/ffmpeg/);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  });

  itFfmpeg(
    "422s when ffmpeg rejects the art, naming what it said",
    async () => {
      const s = store();
      const id = seed(s, { width: 1024, height: 1024 });
      // A PNG header with no image behind it: off-size (so the ffmpeg branch runs) and undecodable
      // (so ffmpeg exits non-zero). A broken *file* is not a broken *server* — hence 422, not 503.
      writeFileSync(s.paths.cardArtFile(id, "png"), pngBytes(1024, 1024));
      const app = curator(s);
      const res = await app.inject({
        method: "GET",
        url: `/api/albums/${id}/card-art/print`,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toMatch(/could not render/i);
    },
  );
});

// Everything above proves the argv is the string we meant. Only the real binary proves it is a string
// ffmpeg will accept — the exact gap that let a broken `-f`-less normalize ship green (issue #180).
describeFfmpeg("the real ffmpeg accepts the print filtergraph", () => {
  const render = async (
    source: { width: number; height: number },
    bleed = false,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "curator-print-real-"));
    const file = join(dir, "art.png");
    writeFileSync(file, pngImage(source.width, source.height));
    return renderCardArtPrint({}, { file, ext: "png", bleed });
  };

  it("crops a square source to exactly 1050x600 at 300 DPI", async () => {
    const out = await render({ width: 1024, height: 1024 });
    expect(imageSize(out.bytes, "png")).toEqual({ width: 1050, height: 600 });
    expect(pngDpi(out.bytes)).toBe(PRINT_DPI);
  }, 30_000);

  it("keeps a portrait source portrait, and honours bleed", async () => {
    const out = await render({ width: 800, height: 1400 }, true);
    expect(imageSize(out.bytes, "png")).toEqual({ width: 675, height: 1125 });
  }, 30_000);
});
