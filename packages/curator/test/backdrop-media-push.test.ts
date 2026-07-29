// Curator streams the visualizer to Backdrop instead of leaving it to an out-of-band rsync
// (ADR 0038 / issue #169). Exercised against a real HTTP server that behaves like Backdrop's
// PUT /api/media/:fileId, so the stream, the headers and the failure paths are the real ones.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { BackdropClient } from "../src/backdrop/client.js";
import { BackdropSync, httpPushTransfer } from "../src/backdrop/sync.js";
import { makeAsset } from "./helpers.js";
import type { AlbumAsset } from "../src/albums/asset.js";

const SECRET = "s3cr3t";

/** A stand-in Backdrop that accepts media uploads and records what arrived. */
function stubBackdrop(opts: { failMedia?: number } = {}) {
  const media: Record<string, Buffer> = {};
  const entries: Record<string, unknown> = {};
  const secrets: Array<string | undefined> = [];
  /** Every upload that actually arrived, in order — so a "skip" is observable, not inferred. */
  const uploads: string[] = [];
  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers["x-trigger-secret"] !== SECRET)
      await reply.code(401).send({ error: "unauthorized" });
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.put("/api/media/:fileId", async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    secrets.push(req.headers["x-trigger-secret"] as string | undefined);
    if (opts.failMedia) {
      return reply.code(opts.failMedia).send({ error: "nope" });
    }
    const buf = req.body as Buffer;
    media[fileId] = buf;
    uploads.push(fileId);
    return reply.code(201).send({ fileId, bytes: buf.length });
  });
  app.post("/api/library/update", async (req) => {
    const b = req.body as { uri: string };
    entries[b.uri] = b;
    return { updated: b.uri };
  });
  app.post("/api/library/sync", async (req) => {
    const b = req.body as { entries: Array<{ uri: string }> };
    for (const e of b.entries) entries[e.uri] = e;
    return { synced: b.entries.length };
  });
  app.get("/api/library", async () => ({
    version: 1,
    updatedAt: "n",
    entries,
  }));
  return { app, media, entries, secrets, uploads };
}

const withVideo = (id: string): AlbumAsset => {
  const a = makeAsset(id);
  a.visualizer = {
    fileId: id,
    originalFilename: "clip.mp4",
    durationSec: 180,
    loopStrategy: "loop",
    attachedAt: "2026-07-11T00:00:00.000Z",
  };
  return a;
};

describe("httpPushTransfer", () => {
  let backdrop: ReturnType<typeof stubBackdrop>;
  let url: string;
  let store: AssetStore;

  const start = async (opts: { failMedia?: number } = {}) => {
    backdrop = stubBackdrop(opts);
    await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = backdrop.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  };

  beforeEach(() => {
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-push-")));
  });
  afterEach(async () => {
    await backdrop?.app.close();
  });

  /** Put a real file where the store expects the album's visualizer to live. */
  const seedVisualizer = (id: string, contents: Buffer) => {
    const asset = withVideo(id);
    store.save(asset);
    const path = store.paths.visualizerFile(id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return store.read(id)!;
  };

  const sync = () =>
    new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: "/home/pi/media/visualizers",
      mediaTransfer: httpPushTransfer(
        new BackdropClient({ url, sharedSecret: SECRET }),
      ),
    });

  it("streams the visualizer to Backdrop and pushes the entry", async () => {
    await start();
    const body = Buffer.from("a small stand-in for 240MB of mp4");
    const asset = seedVisualizer("abc12345", body);

    const res = await sync().syncAlbum(asset);

    expect(res.ok).toBe(true);
    expect(backdrop.media["abc12345"]).toEqual(body);
    expect(backdrop.entries["curator:album:abc12345"]).toBeDefined();
  });

  it("sends the shared secret on the upload, not just the metadata call", async () => {
    await start();
    await sync().syncAlbum(seedVisualizer("abc12345", Buffer.from("x")));
    expect(backdrop.secrets).toContain(SECRET);
  });

  /**
   * The point of the whole change. Before it, `sync` reported success for pushing metadata whether or
   * not the video ever arrived, so an album could read healthy with a black screen behind it. A
   * failed upload must be a failed sync — recorded as a syncIssue like any other, never swallowed.
   */
  it("reports a failed upload as a sync failure rather than a silent success", async () => {
    await start({ failMedia: 507 });
    const asset = seedVisualizer("abc12345", Buffer.from("x"));

    const res = await sync().syncAlbum(asset);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/507|media/i);
    expect(store.read("abc12345")!.roadie.syncIssues?.length).toBeGreaterThan(
      0,
    );
  });

  it("reports a missing local file rather than uploading nothing", async () => {
    await start();
    const asset = withVideo("abc12345");
    store.save(asset); // no file written for it

    const res = await sync().syncAlbum(store.read("abc12345")!);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing/i);
    expect(backdrop.media["abc12345"]).toBeUndefined();
  });

  it("carries the file through byte-for-byte, including a size past one chunk", async () => {
    await start();
    // 512 KB — comfortably more than one 64 KB read, so a naive first-chunk-only push would fail.
    const body = Buffer.alloc(512 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const asset = seedVisualizer("abc12345", body);

    await sync().syncAlbum(asset);

    expect(backdrop.media["abc12345"]!.length).toBe(body.length);
    expect(backdrop.media["abc12345"]).toEqual(body);
  });
});

/**
 * Skip-if-unchanged (ADR 0038). Hashing 228 MB costs ~0.5s against a transfer that took ~90 minutes
 * over a real link, so the check pays for itself many times over — but only if it is exactly right.
 * Skipping when the file HAS changed leaves a stale video playing, which is worse than a slow sync.
 */
describe("re-sync skips an upload only when the file is byte-identical", () => {
  let backdrop: ReturnType<typeof stubBackdrop>;
  let url: string;
  let store: AssetStore;
  let uploads: string[];

  beforeEach(async () => {
    backdrop = stubBackdrop();
    uploads = backdrop.uploads;
    await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(backdrop.app.server.address() as AddressInfo).port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-rehash-")));
  });
  afterEach(async () => {
    await backdrop.app.close();
  });

  const seed = (id: string, contents: Buffer) => {
    store.save(withVideo(id));
    const p = store.paths.visualizerFile(id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents);
    return store.read(id)!;
  };

  const sync = () =>
    new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: "/home/pi/media/visualizers",
      mediaTransfer: httpPushTransfer(
        new BackdropClient({ url, sharedSecret: SECRET }),
      ),
    });

  it("uploads once, then skips an identical re-sync", async () => {
    const asset = seed("abc12345", Buffer.from("identical bytes"));

    await sync().syncAlbum(asset);
    expect(uploads).toEqual(["abc12345"]);

    await sync().syncAlbum(store.read("abc12345")!);
    expect(uploads).toEqual(["abc12345"]); // still one — the second was skipped
  });

  it("re-uploads when the file has changed", async () => {
    seed("abc12345", Buffer.from("first cut"));
    await sync().syncAlbum(store.read("abc12345")!);

    // Same album, same fileId, different content — a re-encode or a replaced video.
    writeFileSync(
      store.paths.visualizerFile("abc12345"),
      Buffer.from("a different edit entirely"),
    );
    await sync().syncAlbum(store.read("abc12345")!);

    expect(uploads).toEqual(["abc12345", "abc12345"]);
  });

  it("advertises the hash it actually sent, so the next sync can compare", async () => {
    const asset = seed("abc12345", Buffer.from("bytes"));
    await sync().syncAlbum(asset);

    const entry = backdrop.entries["curator:album:abc12345"] as {
      contentHash?: string;
    };
    expect(entry.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("re-uploads when the remote entry carries no hash (pre-ADR-0038 or rsync'd)", async () => {
    const asset = seed("abc12345", Buffer.from("bytes"));
    // An entry that exists but was never hashed — unknown, so it must not be trusted as up to date.
    backdrop.entries["curator:album:abc12345"] = {
      uri: "curator:album:abc12345",
      filePath: "/home/pi/media/visualizers/abc12345.mp4",
    };

    await sync().syncAlbum(asset);

    expect(uploads).toEqual(["abc12345"]);
  });

  it("skips uploads across a full resync too, not just single-album sync", async () => {
    const a = seed("abc12345", Buffer.from("one"));
    const b = seed("zzzz9999", Buffer.from("two"));

    await sync().resyncAll([a, b]);
    expect(uploads.sort()).toEqual(["abc12345", "zzzz9999"]);

    await sync().resyncAll([store.read("abc12345")!, store.read("zzzz9999")!]);
    expect(uploads.sort()).toEqual(["abc12345", "zzzz9999"]); // no second round
  });
});

/**
 * A config that names its transfer the old way must keep working. ADR 0038 promises the boolean is
 * still honoured, and wiring that keyed only off the new enum silently ignored it — a config saying
 * "copy the file" that quietly copies nothing is the worst shape this bug can take, because sync
 * still reports success.
 */
describe("legacy syncMediaLocally still selects a transfer", () => {
  it("treats syncMediaLocally:true as local when mediaTransfer is absent", async () => {
    const { effectiveMediaTransferMode } =
      await import("../src/backdrop/sync.js");
    expect(effectiveMediaTransferMode({ syncMediaLocally: true })).toBe(
      "local",
    );
    expect(effectiveMediaTransferMode({ syncMediaLocally: false })).toBe(
      "none",
    );
    // The explicit mode always wins over the legacy boolean.
    expect(
      effectiveMediaTransferMode({
        mediaTransfer: "push",
        syncMediaLocally: true,
      }),
    ).toBe("push");
    expect(
      effectiveMediaTransferMode({
        mediaTransfer: "none",
        syncMediaLocally: true,
      }),
    ).toBe("none");
  });
});

describe("BackdropClient.putMedia", () => {
  it("abandons an upload that stops making progress", async () => {
    // A server that accepts the connection and then never responds: the request is not slow, it is
    // wedged. A deadline-based bound would either kill real slow uploads or take an hour to notice
    // this; the stall timeout catches it in one interval.
    const hung = Fastify();
    hung.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    hung.put("/api/media/:fileId", () => new Promise(() => {}));
    await hung.listen({ port: 0, host: "127.0.0.1" });
    const { port } = hung.server.address() as AddressInfo;

    const dir = mkdtempSync(join(tmpdir(), "push-stall-"));
    const file = join(dir, "v.mp4");
    writeFileSync(file, Buffer.from("payload"));

    try {
      const client = new BackdropClient({
        url: `http://127.0.0.1:${port}`,
        uploadStallMs: 150,
      });
      await expect(client.putMedia("abc12345", file)).rejects.toThrow();
    } finally {
      await hung.close();
    }
  });

  it("reads back the byte count Backdrop reports", async () => {
    const app = Fastify();
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    app.put("/api/media/:fileId", async (req, reply) =>
      reply
        .code(201)
        .send({ fileId: "abc12345", bytes: (req.body as Buffer).length }),
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    const dir = mkdtempSync(join(tmpdir(), "push-bytes-"));
    const file = join(dir, "v.mp4");
    writeFileSync(file, Buffer.alloc(1234, 3));

    try {
      const client = new BackdropClient({ url: `http://127.0.0.1:${port}` });
      expect(await client.putMedia("abc12345", file)).toEqual({ bytes: 1234 });
      expect(readFileSync(file).length).toBe(1234); // source untouched
    } finally {
      await app.close();
    }
  });
});
