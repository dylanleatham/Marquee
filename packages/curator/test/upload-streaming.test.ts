import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import {
  fakeRoadie,
  fakeProber,
  makeAsset,
  buildMultipart,
} from "./helpers.js";
import type { VideoProber, VideoInfo } from "../src/media/video.js";

// Regression guard for issue #16: an upload must stream to disk, not buffer the whole file in
// memory. The observable proxy is memory pressure at ffprobe time: the prober only runs once the
// file has fully landed on disk, so at that moment a *buffered* upload is still holding the entire
// file as a live Buffer (counted in `arrayBuffers`), while a *streamed* one has already flushed the
// bytes and holds nothing proportional to the file. We upload over a real socket (not app.inject,
// which itself buffers the whole payload) and send the body as a stream so the client stays flat
// too — the only place a file-sized allocation can appear is the server's own read path.

// A prober that samples process memory the instant probe() is called, then returns valid H.264 info.
function samplingProber(sample: () => void): VideoProber {
  const info: VideoInfo = {
    durationSec: 180,
    width: 1920,
    height: 1080,
    codec: "h264",
    container: "mov,mp4,m4a,3gp",
  };
  return {
    probe: async () => {
      sample();
      return info;
    },
    thumbnail: async () => {},
  };
}

// A multipart body streamed as: curatorId field, then a `sizeBytes` file part built from one reused
// 1 MB chunk (so the *client* never holds the whole file), then the closing boundary.
function streamedVideoUpload(curatorId: string, sizeBytes: number) {
  const boundary = "----marqueeStream" + Math.random().toString(16).slice(2);
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="curatorId"\r\n\r\n${curatorId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`,
    "utf8",
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const CHUNK = 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK, 0x42); // one buffer, reused for every write
  const contentLength = preamble.length + sizeBytes + epilogue.length;

  async function* gen() {
    yield preamble;
    let sent = 0;
    while (sent < sizeBytes) {
      const n = Math.min(CHUNK, sizeBytes - sent);
      yield n === CHUNK ? chunk : chunk.subarray(0, n);
      sent += n;
    }
    yield epilogue;
  }

  return {
    body: Readable.from(gen()),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
  };
}

describe("upload streaming (issue #16)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("streams a large upload to disk without holding it in memory", async () => {
    const store = new AssetStore(
      mkdtempSync(join(tmpdir(), "curator-stream-")),
    );
    const curatorId = "strm0001";
    store.save(makeAsset(curatorId)); // awaiting_review → video attaches directly (ADR 0005)

    let arrayBuffersAtProbe = 0;
    const prober = samplingProber(() => {
      (globalThis as { gc?: () => void }).gc?.(); // drop already-flushed chunks if gc is exposed
      arrayBuffersAtProbe = process.memoryUsage().arrayBuffers;
    });

    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober,
      config: { maxUploadBytes: 1024 * 1024 * 1024 }, // 1 GB — well above the test file
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    close = () => app.close();
    const { port } = app.server.address() as AddressInfo;

    const FILE_BYTES = 150 * 1024 * 1024; // 150 MB
    (globalThis as { gc?: () => void }).gc?.();
    const baseline = process.memoryUsage().arrayBuffers;

    const upload = streamedVideoUpload(curatorId, FILE_BYTES);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/videos/upload",
          headers: {
            "content-type": upload.contentType,
            "content-length": upload.contentLength,
          },
        },
        (res) => {
          res.resume(); // drain
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      upload.body.pipe(req);
    });

    expect(status).toBe(201);
    expect(store.read(curatorId)!.visualizer).toBeTruthy();

    // Buffering keeps the whole 150 MB live at probe time; streaming holds only in-flight chunks.
    // A generous half-file threshold cleanly separates the two without being flaky.
    const grewBytes = arrayBuffersAtProbe - baseline;
    expect(grewBytes).toBeLessThan(FILE_BYTES / 2);
  });

  // The streamed temp file belongs to the route, which must clean it up on *every* exit — including
  // when the attach is rejected (bad codec → 422) after the file has already landed. Streaming made
  // the temp a first-class thing on disk, so a leak here would accumulate partial uploads.
  it("removes the streamed temp file when the attach is rejected", async () => {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-leak-")));
    const curatorId = "leak0001";
    store.save(makeAsset(curatorId));

    // A prober whose probe reports a non-MP4 container → ingestVideo throws VideoError → 422.
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber({ container: "matroska,webm", codec: "vp9" }),
    });

    const mp = buildMultipart(
      { curatorId },
      {
        field: "file",
        filename: "clip.mkv",
        contentType: "video/x-matroska",
        data: Buffer.alloc(4096, 7),
      },
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/videos/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });

    expect(res.statusCode).toBe(422);
    expect(store.read(curatorId)!.visualizer).toBeUndefined();
    // No `.upload-*` temp (nor any file) left behind in /incoming/.
    const leftovers = existsSync(store.paths.incoming)
      ? readdirSync(store.paths.incoming)
      : [];
    expect(leftovers).toEqual([]);
  });
});
