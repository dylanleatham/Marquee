import { writeFileSync } from "node:fs";
import type { GeneratedPalettePayload } from "@marquee/palette-press";
import { buildAlbumAsset, type AlbumAsset } from "../src/albums/asset.js";
import { Roadie, type RoadieOptions } from "../src/roadie/worker.js";
import type { AssetStore } from "../src/store/asset-store.js";
import type { VideoInfo, VideoProber } from "../src/media/video.js";

/** A video prober that never shells out to ffmpeg: returns canned probe info + writes a stub thumb. */
export const fakeProber = (info?: Partial<VideoInfo>): VideoProber => ({
  probe: async () => ({
    durationSec: 180,
    width: 1920,
    height: 1080,
    codec: "h264",
    container: "mov,mp4,m4a,3gp",
    ...info,
  }),
  thumbnail: async (_file, outPath) => {
    writeFileSync(outPath, Buffer.from("JPGTHUMB"));
  },
});

/** A minimal but structurally-valid PNG buffer of the given dimensions (header only). */
export const pngBytes = (width = 1050, height = 600): Buffer => {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

/** A minimal JPEG buffer with an SOF0 marker carrying the given dimensions (padded past the SOF). */
export const jpegBytes = (width = 600, height = 1050): Buffer => {
  const b = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x01, 0x11, 0x00,
  ]);
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
};

/** A canned palette payload so tests don't run node-vibrant. */
export const fakePayload = (): GeneratedPalettePayload => ({
  version: 1,
  source: { type: "album" },
  palette: {
    colors: [
      {
        hex: "#4B0082",
        cie_xy: [0.2, 0.1],
        role: "primary",
        sourceSwatch: "DarkVibrant",
      },
      { hex: "#FFD700", cie_xy: [0.45, 0.48], role: "secondary" },
    ],
  },
  pattern: { type: "crossfade", params: { transitionMs: 8000, holdMs: 30000 } },
  meta: { generatedAt: "2026-07-11T00:00:00.000Z", generator: "fake@0" },
});

export const fakeGenerate = async () => fakePayload();

/**
 * A Roadie wired for tests: fake palette generator, no-op sleep (backoff is instant), fixed clock,
 * and deterministic jitter. Pass `generate`/`spotify` to override. A full suite runs in <1s (§13).
 */
export const fakeRoadie = (
  store: AssetStore,
  opts: Partial<RoadieOptions> = {},
): Roadie =>
  // `...opts` last so every field is overridable; pass `{ generate: undefined }` to run real Palette
  // Press (Roadie falls back to its default when generate is undefined).
  new Roadie({
    store,
    generate: fakeGenerate,
    sleep: async () => {},
    now: () => "2026-07-11T00:00:00.000Z",
    rand: () => 0,
    ...opts,
  });

export const makeAsset = (
  curatorId: string,
  name = "N",
  artist = "A",
): AlbumAsset =>
  buildAlbumAsset({
    curatorId,
    metadata: { name, artist, source: "manual" },
    artworkPosixPath: `media/artwork/${curatorId}.jpg`,
    contentHash: "sha256:deadbeef",
    palette: fakePayload(),
    now: () => "2026-07-11T00:00:00.000Z",
  });

/** Build a multipart/form-data body for Fastify inject (no form-data dependency needed). */
export function buildMultipart(
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = "----marqueeTest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, "utf8"));

  for (const [k, v] of Object.entries(fields)) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
  }
  if (file) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    );
    chunks.push(file.data);
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
