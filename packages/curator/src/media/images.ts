// Card-art ingest (curator-spec §Card art): validate the upload is a PNG or JPEG, read its
// dimensions from the header (no image library needed), and store it under card-art/{fileId}.{ext}.
// Dimensions are advisory — the spec recommends 1050x600 landscape but doesn't reject other sizes.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Paths } from "../store/paths.js";
import type { CardArtSection, CardArtCandidate } from "../albums/asset.js";

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

/** Sniff the format from magic bytes. Returns the canonical stored extension, or null. */
export function detectImage(buf: Buffer): "png" | "jpg" | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "jpg";
  return null;
}

/** Read pixel dimensions from a PNG (IHDR) or JPEG (SOF) header. Null if it can't be determined. */
export function imageSize(
  buf: Buffer,
  ext: "png" | "jpg",
): { width: number; height: number } | null {
  if (ext === "png") {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments to the start-of-frame, which carries height then width.
  // Need bytes up to i+8 to read both dimensions from a SOF at position i.
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // SOF0..SOF15, excluding DHT(0xC4)/JPG(0xC8)/DAC(0xCC).
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSOF)
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

/**
 * Validate + store an uploaded card-art image. Throws ImageError on a non-PNG/JPEG. Records the
 * stored extension (so the file can be resolved later) plus advisory resolution/orientation.
 */
export function ingestCardArt(
  deps: { paths: Paths; now?: () => string },
  args: { buffer: Buffer; fileId: string; originalFilename: string },
): CardArtSection {
  const ext = detectImage(args.buffer);
  if (!ext) throw new ImageError("Card art must be a PNG or JPEG image.");

  mkdirSync(deps.paths.cardArt, { recursive: true });
  writeFileSync(deps.paths.cardArtFile(args.fileId, ext), args.buffer);

  const size = imageSize(args.buffer, ext);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  return {
    fileId: args.fileId,
    originalFilename: args.originalFilename,
    ext,
    attachedAt: now,
    ...(size
      ? {
          resolution: `${size.width}x${size.height}`,
          orientation: size.width >= size.height ? "landscape" : "portrait",
        }
      : {}),
  };
}

/**
 * Validate + store one Gemini-generated card-art candidate at card-art/{curatorId}-c{index}.{ext}.
 * Same sniff/size logic as `ingestCardArt`, but keyed on the candidate index so the whole set can
 * coexist on disk until the human promotes one.
 */
export function ingestCardArtCandidate(
  deps: { paths: Paths; now?: () => string },
  args: {
    buffer: Buffer;
    curatorId: string;
    index: number;
    nudge?: string;
    /** Set when this image only generated after the cover reference was dropped (ADR 0032). */
    coverReferenceDropped?: boolean;
  },
): CardArtCandidate {
  const ext = detectImage(args.buffer);
  if (!ext)
    throw new ImageError("Generated card art was not a PNG or JPEG image.");

  const fileId = `${args.curatorId}-c${args.index}`;
  mkdirSync(deps.paths.cardArt, { recursive: true });
  writeFileSync(deps.paths.cardArtFile(fileId, ext), args.buffer);

  const size = imageSize(args.buffer, ext);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  return {
    index: args.index,
    fileId,
    ext,
    generatedAt: now,
    ...(args.nudge ? { nudge: args.nudge } : {}),
    ...(args.coverReferenceDropped ? { coverReferenceDropped: true } : {}),
    ...(size
      ? {
          resolution: `${size.width}x${size.height}`,
          orientation: size.width >= size.height ? "landscape" : "portrait",
        }
      : {}),
  };
}
