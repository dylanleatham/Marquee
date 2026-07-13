import type { GeneratedPalettePayload } from "@marquee/palette-press";
import { buildAlbumAsset, type AlbumAsset } from "../src/albums/asset.js";
import { Roadie, type RoadieOptions } from "../src/roadie/worker.js";
import type { AssetStore } from "../src/store/asset-store.js";

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
