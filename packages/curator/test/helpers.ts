import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import type { GeneratedPalettePayload } from "@marquee/palette-press";
import { buildAlbumAsset, type AlbumAsset } from "../src/albums/asset.js";
import { Roadie, type RoadieOptions } from "../src/roadie/worker.js";
import type { AssetStore } from "../src/store/asset-store.js";
import type { VideoInfo, VideoProber } from "../src/media/video.js";

/** A video prober that never shells out to ffmpeg: returns canned probe info + writes a stub thumb. */
export const fakeProber = (info?: Partial<VideoInfo>): VideoProber => ({
  // Defaults sit inside DECODE_BUDGET (issue #180) so tests that aren't about normalizing take the
  // plain copy path — pass `bitRateBps`/`hasAudio` explicitly to exercise the normalize branch.
  probe: async () => ({
    durationSec: 180,
    width: 1920,
    height: 1080,
    codec: "h264",
    container: "mov,mp4,m4a,3gp",
    bitRateBps: 7_300_000,
    fps: 30,
    hasAudio: false,
    ...info,
  }),
  thumbnail: async (_file, outPath) => {
    writeFileSync(outPath, Buffer.from("JPGTHUMB"));
  },
  // Records which clips were joined (in order) so splice tests can assert the selection/ordering.
  concat: async (files, outPath) => {
    writeFileSync(outPath, Buffer.from(`SPLICED:${files.join(",")}`));
  },
  normalize: async (_src, outPath) => {
    writeFileSync(outPath, Buffer.from("NORMALIZED"));
  },
});

/**
 * A PNG *header* of the given dimensions — enough for `detectImage`/`imageSize`, which only read the
 * signature and IHDR's first eight data bytes. Not a decodable image and not chunk-walkable: anything
 * that parses the chunk stream (or hands the file to ffmpeg) wants `pngImage` below.
 */
export const pngBytes = (width = 1050, height = 600): Buffer => {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

/**
 * A genuinely decodable 8-bit RGB PNG: real IHDR/IDAT/IEND chunks with correct CRCs over a solid
 * mid-grey field. The print render both walks the chunk stream (to insert `pHYs`) and, in the
 * ffmpeg integration test, actually decodes the file — neither works on `pngBytes`'s header stub.
 */
export const pngImage = (width = 1024, height = 1024): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, "ascii");
    data.copy(c, 8);
    c.writeUInt32BE(
      crc32(c.subarray(4, 8 + data.length)) >>> 0,
      8 + data.length,
    );
    return c;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour RGB
  // Each scanline is a filter byte (0 = none) followed by width RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let y = 0; y < height; y++) raw.writeUInt8(0, y * (1 + width * 3));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * A decodable PNG with actual **colour** in it — horizontal bands, one per hex given.
 *
 * `pngImage` is a solid mid-grey field, which is right for anything that only walks the chunk stream
 * but is the one thing a palette extractor cannot do its job on: a single flat tone comes back
 * `insufficient`. This exists for the tests that run the real Palette Press (`server-wiring.test.ts`,
 * [#319](https://github.com/dylanleatham/Marquee/issues/319)) and therefore need a cover with
 * something to find. Deliberately large-banded rather than noisy — the extractor quantises, so a few
 * broad, saturated, well-separated blocks are what make the assertion about wiring rather than about
 * how good node-vibrant is on a particular image.
 */
export const pngBands = (
  hexes: string[] = ["#0B6E4F", "#E8871E", "#124E78", "#F2E8CF", "#8B1E3F"],
  size = 128,
): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, "ascii");
    data.copy(c, 8);
    c.writeUInt32BE(
      crc32(c.subarray(4, 8 + data.length)) >>> 0,
      8 + data.length,
    );
    return c;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour RGB

  const rgb = hexes.map((h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]);
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const [r, g, b] = rgb[Math.floor((y / size) * rgb.length)]!;
    raw.writeUInt8(0, y * stride); // filter: none
    for (let x = 0; x < size; x++) {
      const at = y * stride + 1 + x * 3;
      raw.writeUInt8(r!, at);
      raw.writeUInt8(g!, at + 1);
      raw.writeUInt8(b!, at + 2);
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

/**
 * The `announce` every album-creation path requires
 * ([#343](https://github.com/dylanleatham/Marquee/issues/343)), for the suites that are about
 * something else. Required rather than optional in `NewAlbumDeps` on purpose — a new creation path
 * has to say what announcing means, which is the question the Backdrop trigger list stopped asking.
 */
export const noAnnounce = async (): Promise<void> => {};

/** Records the curatorIds announced, for the suites that *are* about the announce. */
export const spyAnnounce = (): {
  announce: (asset: AlbumAsset) => Promise<void>;
  announced: string[];
} => {
  const announced: string[] = [];
  return {
    announce: async (asset: AlbumAsset) => {
      announced.push(asset.curatorId);
    },
    announced,
  };
};

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

/**
 * An empty desk: the `FlipperPusher` a test gets when no Flipper is meant to be involved, rejecting
 * with the message `connect()` really uses.
 *
 * **Pass this to `buildServer` in any suite that hits `POST /api/runtime/sync`.** That route pushes
 * the tag queue to a Flipper as its last leg, so a suite that leaves the default in place drives the
 * *real* serial stack — enumerating the developer's COM ports, and writing a temp store's test
 * albums onto an actually-attached device. Injecting here keeps the suite hermetic and keeps
 * `pnpm test` from touching hardware on the desk.
 */
export const noFlipper = async (): Promise<never> => {
  throw new Error(
    "No Flipper found on USB. Plug it in, unlock it, and try again.",
  );
};

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
