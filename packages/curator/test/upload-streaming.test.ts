import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
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

// Regression guard for issue #16 / ADR 0006: an upload must stream to disk, not buffer the whole
// file in memory.
//
// The observable is **the temp file growing on disk while the body is still arriving**. A streamed
// upload pipes each chunk straight to `incoming/.upload-<uuid>`, so a partial file is visible almost
// immediately; a buffered one (`part.toBuffer()`) writes nothing until the entire part has been read,
// so no partial file ever exists. We upload over a real socket — not `app.inject`, which buffers the
// whole payload itself — and stream the body so the client never holds the file either.
//
// This replaced a `process.memoryUsage().arrayBuffers` probe (issue #107). That reading is
// process-wide, and the test's own HTTP client lives in the same process as the server: under load
// the client's outgoing socket queues chunks, which counted against the server's budget and failed
// the assertion. Disk state has the opposite failure profile — a slower run widens the window in
// which a partial file is observable, so load makes this *more* reliable, not less.

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

    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { maxUploadBytes: 1024 * 1024 * 1024 }, // 1 GB — well above the test file
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    close = () => app.close();
    const { port } = app.server.address() as AddressInfo;

    const FILE_BYTES = 150 * 1024 * 1024; // 150 MB

    /** Size of the in-flight temp file, or -1 when none exists yet. */
    const partialSize = (): number => {
      if (!existsSync(store.paths.incoming)) return -1;
      const name = readdirSync(store.paths.incoming).find((n) =>
        n.startsWith(".upload-"),
      );
      if (!name) return -1;
      try {
        return statSync(store.paths.incomingFile(name)).size;
      } catch {
        return -1; // claimed/renamed between readdir and stat
      }
    };

    const partials: number[] = [];
    const poll = setInterval(() => {
      const size = partialSize();
      if (size > 0) partials.push(size);
    }, 10);

    const upload = streamedVideoUpload(curatorId, FILE_BYTES);
    let status = 0;
    try {
      status = await new Promise<number>((resolve, reject) => {
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
    } finally {
      clearInterval(poll);
    }

    expect(status).toBe(201);
    expect(store.read(curatorId)!.visualizer).toBeTruthy();

    // The discriminating observation: bytes reached disk *before* the whole part had been read.
    // Buffering produces no partial file at all, so `partials` would be empty.
    expect(
      partials.length,
      "no partial temp file was ever visible — the upload buffered the whole part before writing",
    ).toBeGreaterThan(0);
    expect(Math.min(...partials)).toBeLessThan(FILE_BYTES);
    // A generous ceiling: buffering 150 MB is also much slower, so a regression that somehow still
    // produced a partial file would trip the clock instead of passing quietly.
  }, 30_000);

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
