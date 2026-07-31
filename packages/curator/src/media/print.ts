// Card-art print render (curator-spec §Card art, issue #98 / ADR 0042). The stored art is whatever
// the human uploaded or Gemini generated — any size, any aspect — and `/card-art/print` has to hand
// back something you can actually send to a printer: business-card dimensions at 300 DPI.
//
// Two things have to be true of the bytes we return, and they need different tools:
//   1. Geometry — scale-to-cover the card box and centre-crop the overflow (ADR 0042). That needs a
//      real image pipeline, and Curator's is ffmpeg: already a documented dependency, already staged
//      into the packaged desktop app, already driven through video.ts's bounded `run()`.
//   2. Physical size — a raster file only says "3.5 inches wide" via its DPI metadata, which ffmpeg
//      does not write for either PNG or JPEG. So we stamp it ourselves: a PNG `pHYs` chunk, or a
//      JPEG JFIF APP0 density. Both are a handful of bytes and neither needs a decoder.
//
// Art that is *already* card-sized skips ffmpeg entirely and only gets the stamp, so the download
// keeps working on a workstation with no ffmpeg installed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { ffmpegBin, VideoError, run } from "./video.js";
import { imageSize } from "./images.js";

export class PrintError extends Error {
  /**
   * `unavailable` — this workstation has no ffmpeg, so the render can't be attempted (503).
   * `failed` — ffmpeg ran and rejected the art, or the bytes aren't the image they claim to be (422).
   * Same distinction video.ts's `VideoError.binaryUnavailable` draws, carried up to the route so a
   * missing dependency doesn't get reported as a corrupt file.
   */
  readonly kind: "unavailable" | "failed";

  // Options object rather than a positional flag, matching VideoError next door.
  constructor(message: string, opts: { kind?: "unavailable" | "failed" } = {}) {
    super(message);
    this.name = "PrintError";
    this.kind = opts.kind ?? "failed";
  }
}

/** Print resolution the spec promises. 3.5in x 2in at 300 DPI is exactly 1050x600 px. */
export const PRINT_DPI = 300;
const CARD_LONG_IN = 3.5;
const CARD_SHORT_IN = 2;
/** Standard commercial bleed: 0.125in past the trim line on every edge, so +0.25in per axis. */
const BLEED_IN = 0.125;

/** A wall-clock cap for the render, in the spirit of video.ts: one small still, so 30s is generous. */
const PRINT_TIMEOUT_MS = 30_000;

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * The pixel box to render into. Orientation follows the source — a portrait card is a real thing and
 * the upload path already records the distinction — so a taller-than-wide source gets 600x1050 rather
 * than being rotated into a landscape card. An unreadable source falls back to landscape.
 *
 * `bleed` widens the box to the printer's trim allowance (1125x675); the trim line then sits 37.5px
 * inside each edge, which the card-art metaprompt's 144px safe boundary already keeps clear of.
 */
export function printTarget(
  source: PixelSize | null,
  { bleed = false }: { bleed?: boolean } = {},
): PixelSize {
  const grow = bleed ? 2 * BLEED_IN : 0;
  const long = Math.round((CARD_LONG_IN + grow) * PRINT_DPI);
  const short = Math.round((CARD_SHORT_IN + grow) * PRINT_DPI);
  return source && source.height > source.width
    ? { width: short, height: long }
    : { width: long, height: short };
}

/**
 * The smallest box that covers `target` while keeping `source`'s aspect ratio — i.e. scale-to-fill,
 * which is then centre-cropped back to `target`. Clamped up to `target` on both axes because
 * rounding the scaled edge can land a pixel short, and a crop larger than its input fails.
 */
export function coverBox(source: PixelSize, target: PixelSize): PixelSize {
  const scale = Math.max(
    target.width / source.width,
    target.height / source.height,
  );
  return {
    width: Math.max(target.width, Math.round(source.width * scale)),
    height: Math.max(target.height, Math.round(source.height * scale)),
  };
}

/**
 * ffmpeg argv for the render. With a known source size we compute the cover box ourselves so the
 * command is deterministic and unit-testable; when the header wouldn't parse we hand the same job to
 * ffmpeg's `force_original_aspect_ratio=increase`, which needs no dimensions from us. `crop` centres
 * by default, so the overflow comes off both edges evenly.
 */
export function buildPrintArgs(
  src: string,
  dest: string,
  source: PixelSize | null,
  target: PixelSize,
): string[] {
  const box = source ? coverBox(source, target) : null;
  const scale = box
    ? `scale=${box.width}:${box.height}:flags=lanczos`
    : `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:flags=lanczos`;
  return [
    "-y",
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    `${scale},crop=${target.width}:${target.height}`,
    "-f",
    "image2",
    "-c:v",
    "png",
    dest,
  ];
}

/** A PNG chunk: big-endian length, 4-char type, data, CRC32 over type+data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(
    crc32(out.subarray(4, 8 + data.length)) >>> 0,
    8 + data.length,
  );
  return out;
}

/**
 * Stamp a PNG's physical resolution by inserting a `pHYs` chunk after IHDR (replacing any existing
 * one). pHYs is in pixels *per metre*, so 300 DPI is 300/0.0254 ≈ 11811 — the rounding is the format's,
 * not ours, and every print pipeline reads it back as 300.
 */
export function withPngDpi(buf: Buffer, dpi = PRINT_DPI): Buffer {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47)
    throw new PrintError("Print render did not produce a PNG.");

  const ppm = Math.round(dpi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data.writeUInt8(1, 8); // unit specifier: 1 = metre
  const phys = pngChunk("pHYs", data);

  const parts: Buffer[] = [buf.subarray(0, 8)];
  let inserted = false;
  let at = 8;
  while (at + 8 <= buf.length) {
    const end = at + 12 + buf.readUInt32BE(at);
    if (end > buf.length) break; // truncated chunk — copied through verbatim below
    const type = buf.toString("ascii", at + 4, at + 8);
    if (type !== "pHYs") parts.push(buf.subarray(at, end));
    at = end;
    if (type === "IHDR") {
      parts.push(phys);
      inserted = true;
    }
  }
  if (!inserted) throw new PrintError("Card art PNG has no IHDR chunk.");
  if (at < buf.length) parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}

/**
 * Stamp a JPEG's density into its JFIF APP0 segment. A JFIF header, when present, is always the first
 * segment after SOI, so it can be patched in place; a JPEG that opens with something else (Exif APP1
 * is the common case) gets a minimal APP0 spliced in ahead of it.
 */
export function withJpegDpi(buf: Buffer, dpi = PRINT_DPI): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
    throw new PrintError("Card art is not a JPEG.");

  const hasJfif =
    buf.length >= 20 &&
    buf[2] === 0xff &&
    buf[3] === 0xe0 &&
    buf.toString("ascii", 6, 10) === "JFIF";
  if (hasJfif) {
    const out = Buffer.from(buf);
    out.writeUInt8(1, 13); // density units: 1 = dots per inch
    out.writeUInt16BE(dpi, 14); // Xdensity
    out.writeUInt16BE(dpi, 16); // Ydensity
    return out;
  }

  // FFE0 · len 16 · "JFIF\0" · v1.2 · units=1 · Xdensity · Ydensity · no thumbnail.
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x01, 0,
    0, 0, 0, 0x00, 0x00,
  ]);
  app0.writeUInt16BE(dpi, 12);
  app0.writeUInt16BE(dpi, 14);
  return Buffer.concat([buf.subarray(0, 2), app0, buf.subarray(2)]);
}

export interface PrintRender {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
  ext: "png" | "jpg";
  /** The box the art was fitted to — 1050x600, or 1125x675 with bleed (or their portrait forms). */
  target: PixelSize;
  /** False when the art was already card-sized and only needed the DPI stamp (no ffmpeg run). */
  rendered: boolean;
}

/** ffmpeg + timeout injected so tests can drive both branches without shelling out. */
export interface PrintDeps {
  run?: typeof run;
  ffmpeg?: string;
  timeoutMs?: number;
}

/**
 * Render the attached card art into something printable. Throws `PrintError` if ffmpeg is missing or
 * the render fails — the caller answers 503, because the art is fine and the pipeline is not.
 */
export async function renderCardArtPrint(
  deps: PrintDeps,
  args: { file: string; ext: "png" | "jpg"; bleed?: boolean },
): Promise<PrintRender> {
  const src = readFileSync(args.file);
  const size = imageSize(src, args.ext);
  const target = printTarget(size, { bleed: args.bleed });

  // Already exactly card-sized: the geometry is a no-op, so don't spawn ffmpeg for it.
  if (size && size.width === target.width && size.height === target.height)
    return {
      bytes: args.ext === "png" ? withPngDpi(src) : withJpegDpi(src),
      contentType: args.ext === "png" ? "image/png" : "image/jpeg",
      ext: args.ext,
      target,
      rendered: false,
    };

  const dir = mkdtempSync(join(tmpdir(), "marquee-print-"));
  const dest = join(dir, "card-print.png");
  try {
    await (deps.run ?? run)(
      deps.ffmpeg ?? ffmpegBin(),
      buildPrintArgs(args.file, dest, size, target),
      deps.timeoutMs ?? PRINT_TIMEOUT_MS,
    );
    return {
      bytes: withPngDpi(readFileSync(dest)),
      contentType: "image/png",
      ext: "png",
      target,
      rendered: true,
    };
  } catch (err) {
    if (err instanceof PrintError) throw err;
    throw new PrintError(
      `Could not render the print version: ${(err as Error).message}`,
      {
        kind:
          err instanceof VideoError && err.binaryUnavailable
            ? "unavailable"
            : "failed",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
