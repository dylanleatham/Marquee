import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber, buildMultipart } from "./helpers.js";

// Regression coverage for issue #12: a >1 GB visualizer video failed to upload, because the
// multipart ceiling was a hardcoded 500 MB and an over-ceiling file surfaced as a generic 500
// instead of a clean "too large" 413. The ceiling itself is covered in config.test.ts; this file
// covers what the HTTP surface does on either side of it.

function serverWithLimit(maxUploadBytes: number) {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-upload-")));
  const { app } = buildServer({
    store,
    roadie: fakeRoadie(store),
    prober: fakeProber(),
    config: { maxUploadBytes },
  });
  return { app, store };
}

// Upload with no curatorId → stashes in /incoming/, so we exercise the size limit without needing
// an album in a video-attachable state.
const upload = (
  app: ReturnType<typeof serverWithLimit>["app"],
  url: string,
  file: { filename: string; contentType: string; data: Buffer },
) => {
  const mp = buildMultipart({}, { field: "file", ...file });
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
};

const video = (data: Buffer) => ({
  filename: "clip.mp4",
  contentType: "video/mp4",
  data,
});
const cardArt = (data: Buffer) => ({
  filename: "card.png",
  contentType: "image/png",
  data,
});

describe("upload size limit (issue #12)", () => {
  it("rejects an over-limit video upload with a clean 413, not a 500", async () => {
    const { app } = serverWithLimit(64); // 64-byte ceiling
    const res = await upload(
      app,
      "/api/videos/upload",
      video(Buffer.alloc(4096, 1)),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/too large/i);
  });

  // Both multipart upload routes share readUpload, so both had the same 500 bug.
  it("rejects an over-limit card-art upload with a clean 413 too", async () => {
    const { app } = serverWithLimit(64);
    const res = await upload(
      app,
      "/api/card-art/upload",
      cardArt(Buffer.alloc(4096, 1)),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/too large/i);
  });

  it("names the configured limit so the caller knows what to aim under", async () => {
    const { app } = serverWithLimit(100 * 1024 * 1024); // 100 MB
    const res = await upload(
      app,
      "/api/videos/upload",
      video(Buffer.alloc(200 * 1024 * 1024, 1)), // 200 MB
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toContain("100 MB");
  });

  it("accepts an upload comfortably under the configured limit", async () => {
    const { app } = serverWithLimit(1024 * 1024); // 1 MB ceiling
    const res = await upload(
      app,
      "/api/videos/upload",
      video(Buffer.alloc(4096, 1)),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().incoming).toBeTruthy();
  });
});
