import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { BackdropClient } from "../src/backdrop/client.js";
import { BackdropSync, localCopyTransfer } from "../src/backdrop/sync.js";
import {
  fakeRoadie,
  fakeProber,
  makeAsset,
  buildMultipart,
} from "./helpers.js";
import type { AlbumAsset } from "../src/albums/asset.js";

const SECRET = "s3cr3t";

/** A stand-in Backdrop: a real HTTP library-sync API backed by an in-memory map, enforcing auth. */
function stubBackdrop(secret: string | null = SECRET) {
  // `contentHash` is part of Backdrop's real library shape (backdrop-spec §9) and is what lets a
  // resync skip an upload. The stub used to drop it, so the skip path was untestable (issue #187).
  const entries: Record<
    string,
    { filePath: string; durationSec?: number; contentHash?: string }
  > = {};
  const received: Array<{ method: string; path: string; body: unknown }> = [];
  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (secret && req.headers["x-trigger-secret"] !== secret)
      await reply.code(401).send({ error: "unauthorized" });
  });
  app.post("/api/library/update", async (req) => {
    const b = req.body as {
      uri: string;
      filePath: string;
      durationSec?: number;
      contentHash?: string;
    };
    received.push({ method: "POST", path: "/api/library/update", body: b });
    entries[b.uri] = {
      filePath: b.filePath,
      durationSec: b.durationSec,
      ...(b.contentHash ? { contentHash: b.contentHash } : {}),
    };
    return { updated: b.uri };
  });
  app.post("/api/library/sync", async (req) => {
    const b = req.body as {
      entries: Array<{ uri: string; filePath: string; contentHash?: string }>;
    };
    received.push({ method: "POST", path: "/api/library/sync", body: b });
    for (const k of Object.keys(entries)) delete entries[k];
    for (const e of b.entries)
      entries[e.uri] = {
        filePath: e.filePath,
        ...(e.contentHash ? { contentHash: e.contentHash } : {}),
      };
    return { synced: b.entries.length };
  });
  app.delete("/api/library/:uri", async (req) => {
    const uri = decodeURIComponent((req.params as { uri: string }).uri);
    received.push({
      method: "DELETE",
      path: `/api/library/${uri}`,
      body: null,
    });
    const had = uri in entries;
    delete entries[uri];
    return { removed: had };
  });
  app.get("/api/library", async () => ({
    version: 1,
    updatedAt: "now",
    entries,
  }));
  return { app, entries, received };
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

describe("BackdropSync → Backdrop (real HTTP)", () => {
  let backdrop: ReturnType<typeof stubBackdrop>;
  let url: string;
  let store: AssetStore;
  let mediaDir: string;

  beforeEach(async () => {
    backdrop = stubBackdrop();
    await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = backdrop.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-sync-")));
    mediaDir = mkdtempSync(join(tmpdir(), "backdrop-media-"));
  });
  afterEach(async () => {
    await backdrop.app.close();
  });

  const sync = (opts: { local?: boolean } = {}) =>
    new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: mediaDir,
      ...(opts.local ? { mediaTransfer: localCopyTransfer(mediaDir) } : {}),
    });

  it("pushes an album's entry with the shared secret", async () => {
    store.save(withVideo("abc12345"));
    const res = await sync().syncAlbum(store.read("abc12345")!);
    expect(res.ok).toBe(true);
    expect(backdrop.entries["curator:album:abc12345"]).toEqual({
      filePath: join(mediaDir, "abc12345.mp4").split("\\").join("/"),
      durationSec: 180,
    });
  });

  it("removes the entry when an album has no video", async () => {
    backdrop.entries["curator:album:novid123"] = { filePath: "/stale.mp4" };
    const res = await sync().syncAlbum(makeAsset("novid123"));
    expect(res.ok).toBe(true);
    expect(backdrop.entries["curator:album:novid123"]).toBeUndefined();
    expect(backdrop.received.at(-1)!.method).toBe("DELETE");
  });

  it("copies the visualizer file into Backdrop's media dir when local sync is on", async () => {
    const a = withVideo("copy1234");
    store.save(a);
    // Put a real mp4 where the projection expects Curator's local copy to be.
    const src = store.paths.visualizerFile("copy1234");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(src, Buffer.from("MP4BYTES"));

    await sync({ local: true }).syncAlbum(store.read("copy1234")!);
    const dest = join(mediaDir, "copy1234.mp4");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest).toString()).toBe("MP4BYTES");
  });

  it("records a syncIssue (and never throws) when Backdrop is unreachable", async () => {
    store.save(withVideo("dead0001"));
    const deadSync = new BackdropSync({
      store,
      client: new BackdropClient({ url: "http://127.0.0.1:1", timeoutMs: 500 }),
      backdropMediaDir: mediaDir,
    });
    const res = await deadSync.syncAlbum(store.read("dead0001")!);
    expect(res.ok).toBe(false);
    const issues = store.read("dead0001")!.roadie.syncIssues;
    expect(issues[0]).toMatch(/^Backdrop: sync failed/);
    // The issue surfaces in the derived status the UI renders.
    expect(store.read("dead0001")!.status.issues).toContain(issues[0]);
  });

  it("clears the syncIssue once a later sync succeeds", async () => {
    const a = withVideo("recover1");
    a.roadie.syncIssues = ["Backdrop sync failed: old"];
    store.save(a);
    await sync().syncAlbum(store.read("recover1")!);
    expect(store.read("recover1")!.roadie.syncIssues).toEqual([]);
  });

  it("resyncAll replaces the whole library with the videoed albums", async () => {
    store.save(withVideo("has0vid1"));
    store.save(makeAsset("no0video")); // no visualizer → skipped
    backdrop.entries["curator:album:stale999"] = { filePath: "/gone.mp4" };
    const result = await sync().resyncAll(store.list());
    expect(result.pushed).toBe(1);
    expect(Object.keys(backdrop.entries)).toEqual(["curator:album:has0vid1"]);
  });

  // ADR 0045: a full resync in `push` mode streams every visualizer — hours on a poor link — so it
  // runs inside a job. A job you cannot watch or stop is not meaningfully better than a blocked
  // request, so progress and cancellation have to reach all the way down.
  it("resyncAll reports progress per album, counting ones with no video", async () => {
    store.save(withVideo("prog0001"));
    store.save(makeAsset("prog0002")); // no visualizer — still an album we walked past
    const seen: Array<[number, number]> = [];
    await sync().resyncAll(store.list(), {
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("resyncAll stops between albums when cancelled", async () => {
    for (const id of ["canc0001", "canc0002", "canc0003"])
      store.save(withVideo(id));
    const ac = new AbortController();
    const result = await sync().resyncAll(store.list(), {
      onProgress: (done) => {
        if (done === 1) ac.abort();
      },
      signal: ac.signal,
    });
    expect(result.pushed).toBe(1);
  });

  it("resyncAll hands the signal to the upload, so a cancel aborts the transfer in flight", async () => {
    store.save(withVideo("abrt0001"));
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(store.paths.visualizerFile("abrt0001"), Buffer.from("MP4"));
    let sawSignal: AbortSignal | undefined;
    const spySync = new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: mediaDir,
      mediaTransfer: {
        mode: "push",
        async copyVisualizer(_src, _fileId, ctx) {
          sawSignal = ctx?.signal;
        },
      },
    });
    const ac = new AbortController();
    await spySync.resyncAll(store.list(), { signal: ac.signal });
    expect(sawSignal).toBe(ac.signal);
  });

  // Issue #187: `{"pushed":12,"failures":[]}` came back instantly right after nine visualizers were
  // re-encoded and needed re-uploading. It read as a complete success and moved zero bytes, because
  // `pushed` counts library entries and `media_transfer` defaults to `none`. The response has to say
  // which it did — this is the silence ADR 0038 set out to remove, still present under the default.
  it("resyncAll says no media was attempted when transfer is off", async () => {
    store.save(withVideo("has0vid1"));
    const result = await sync().resyncAll(store.list());
    expect(result.pushed).toBe(1);
    expect(result.mediaTransfer).toBe("none");
    expect(result.media).toEqual({ transferred: 0, unchanged: 0, skipped: 1 });
  });

  /** `withVideo` sets the visualizer metadata only; a transfer needs actual bytes on disk. */
  const withVideoFile = (id: string): AlbumAsset => {
    const a = withVideo(id);
    store.save(a);
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(store.paths.visualizerFile(id), Buffer.from(`MP4-${id}`));
    return a;
  };

  it("resyncAll counts the files it actually transferred", async () => {
    withVideoFile("has0vid1");
    withVideoFile("has0vid2");
    const result = await sync({ local: true }).resyncAll(store.list());
    expect(result.mediaTransfer).toBe("local");
    expect(result.failures).toEqual([]);
    expect(result.media).toEqual({ transferred: 2, unchanged: 0, skipped: 0 });
  });

  it("resyncAll reports a file it skipped as already up to date", async () => {
    withVideoFile("has0vid1");
    const first = await sync({ local: true }).resyncAll(store.list());
    expect(first.media.transferred).toBe(1);
    // Second run: the entry now carries the same contentHash, so the bytes aren't sent again.
    const again = await sync({ local: true }).resyncAll(store.list());
    expect(again.media).toEqual({ transferred: 0, unchanged: 1, skipped: 0 });
  });

  it("verify reports URIs missing from Backdrop", async () => {
    store.save(withVideo("present1"));
    store.save(withVideo("missing1"));
    await sync().syncAlbum(store.read("present1")!); // only this one is pushed
    const { ok, discrepancies } = await sync().verify(store.list());
    expect(ok).toBe(false);
    expect(discrepancies).toEqual([
      "curator:album:missing1 not in the library",
    ]);
  });

  // Issue #55 / ADR 0015: ★verify-on-verified confirms one album is present and records any drift as
  // its syncIssues (non-blocking), the symmetric counterpart to syncAlbum.
  it("verifyAlbum records a discrepancy as the album's syncIssues when it isn't in Backdrop", async () => {
    store.save(withVideo("verme001"));
    const check = await sync().verifyAlbum(store.read("verme001")!);
    expect(check.ok).toBe(false);
    expect(store.read("verme001")!.roadie.syncIssues).toEqual([
      "Backdrop: curator:album:verme001 not in the library",
    ]);
  });

  it("verifyAlbum clears syncIssues once the album is present", async () => {
    store.save(withVideo("verme002"));
    await sync().syncAlbum(store.read("verme002")!); // push it first
    const check = await sync().verifyAlbum(store.read("verme002")!);
    expect(check.ok).toBe(true);
    expect(store.read("verme002")!.roadie.syncIssues).toEqual([]);
  });
});

describe("server routes trigger Backdrop sync", () => {
  let backdrop: ReturnType<typeof stubBackdrop>;
  let url: string;
  let store: AssetStore;
  let mediaDir: string;

  beforeEach(async () => {
    backdrop = stubBackdrop();
    await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(backdrop.app.server.address() as AddressInfo).port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-route-")));
    mediaDir = mkdtempSync(join(tmpdir(), "backdrop-rmedia-"));
  });
  afterEach(async () => {
    await backdrop.app.close();
  });

  const server = () =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: {
        backdrop: {
          url,
          sharedSecret: SECRET,
          mediaDir,
          syncMediaLocally: true,
        },
      },
    }).app;

  const uploadVideo = (app: ReturnType<typeof server>, curatorId: string) => {
    const mp = buildMultipart(
      { curatorId },
      {
        field: "file",
        filename: "clip.mp4",
        contentType: "video/mp4",
        data: Buffer.from("VIDEOBYTES"),
      },
    );
    return app.inject({
      method: "POST",
      url: "/api/videos/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
  };

  /**
   * The file transfer is a background job now (issue #177) — the upload response returns as soon as
   * the metadata is pushed, so a test that wants to see the file must wait for the job, exactly as
   * the UI does. Polls the same `GET /api/jobs` the client polls rather than reaching into internals.
   */
  const awaitTransfers = async (
    app: ReturnType<typeof server>,
    curatorId: string,
  ) => {
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/albums/${curatorId}/jobs?kind=mediaTransfer`,
      });
      const running = (
        res.json().jobs as Array<{ kind: string; status: string }>
      ).filter((j) => j.status === "running");
      if (running.length === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("media transfer job did not finish");
  };

  it("uploading + attaching a video pushes it to Backdrop and copies the file", async () => {
    // Seed a reviewed album so the video can attach.
    const a = makeAsset("route123");
    a.roadie.state = "awaiting_review";
    a.roadie.history = [{ state: "awaiting_review", at: a.createdAt }];
    store.save(a);

    const app = server();
    const up = await uploadVideo(app, "route123");
    expect(up.statusCode).toBe(201);
    // Metadata lands on the request path; the file follows in the background.
    expect(backdrop.entries["curator:album:route123"]).toBeTruthy();
    expect(up.json().transferJobId).toBeTruthy();

    await awaitTransfers(app, "route123");
    expect(existsSync(join(mediaDir, "route123.mp4"))).toBe(true);
  });

  /**
   * A second video attached while the first is still transferring is *not* the same work, but
   * `jobs.start` dedups on album+kind and would hand back the stale job — the new file would never
   * be sent, and the old job would go on to publish a contentHash for a file the album no longer
   * uses, after which skip-if-unchanged skips the correct one forever. A newer attach supersedes.
   */
  it("supersedes an in-flight transfer when a new video is attached", async () => {
    const a = makeAsset("super001");
    a.roadie.state = "awaiting_review";
    a.roadie.history = [{ state: "awaiting_review", at: a.createdAt }];
    store.save(a);
    const app = server();

    const first = await uploadVideo(app, "super001");
    const firstJob = first.json().transferJobId as string;
    expect(firstJob).toBeTruthy();

    const second = await uploadVideo(app, "super001");
    const secondJob = second.json().transferJobId as string;

    // A distinct job — not the first one handed back.
    expect(secondJob).toBeTruthy();
    expect(secondJob).not.toBe(firstJob);

    await awaitTransfers(app, "super001");
    const jobsRes = await app.inject({
      method: "GET",
      url: "/api/albums/super001/jobs?kind=mediaTransfer",
    });
    const all = jobsRes.json().jobs as Array<{ id: string; status: string }>;
    // The superseded one is not left running forever.
    expect(all.find((j) => j.id === firstJob)?.status).not.toBe("running");
  });

  /**
   * Detaching while a transfer is still in flight. The job holds a snapshot of the album taken when
   * it started — one that still has a visualizer — so on completion it re-upserts the entry that
   * detach just removed, and Backdrop goes on playing a video the user deliberately took away.
   *
   * The cancellation must therefore run for *any* video change, not only ones that owe a transfer:
   * detach owes nothing, which is exactly why it used to skip the cancel.
   */
  it("cancels an in-flight transfer on detach, so it cannot resurrect the entry", async () => {
    const a = makeAsset("detach99");
    a.roadie.state = "awaiting_review";
    a.roadie.history = [{ state: "awaiting_review", at: a.createdAt }];
    store.save(a);
    const app = server();

    await uploadVideo(app, "detach99");
    expect(backdrop.entries["curator:album:detach99"]).toBeTruthy();

    const detach = await app.inject({
      method: "POST",
      url: "/api/albums/detach99/detach-video",
    });
    expect(detach.statusCode).toBe(200);

    // Let anything still running settle, then the entry must stay gone.
    await awaitTransfers(app, "detach99");
    expect(backdrop.entries["curator:album:detach99"]).toBeUndefined();
  });

  it("claiming an /incoming/ video via attach-video pushes it to Backdrop", async () => {
    const a = makeAsset("claim001");
    a.roadie.state = "awaiting_review";
    a.roadie.history = [{ state: "awaiting_review", at: a.createdAt }];
    store.save(a);
    const app = server();

    // Stash a file in /incoming/ (upload with no curatorId), then claim it by fileId.
    const mp = buildMultipart(
      {},
      {
        field: "file",
        filename: "loop.mp4",
        contentType: "video/mp4",
        data: Buffer.from("VIDEOBYTES"),
      },
    );
    const stash = await app.inject({
      method: "POST",
      url: "/api/videos/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    const name = stash.json().incoming;
    const attach = await app.inject({
      method: "POST",
      url: "/api/albums/claim001/attach-video",
      payload: { fileId: name },
    });
    expect(attach.statusCode).toBe(200);
    expect(backdrop.entries["curator:album:claim001"]).toBeTruthy();

    await awaitTransfers(app, "claim001");
    expect(existsSync(join(mediaDir, "claim001.mp4"))).toBe(true);
  });

  it("detaching the video removes it from Backdrop", async () => {
    const a = withVideo("detach01");
    a.roadie.state = "awaiting_preview";
    store.save(a);
    backdrop.entries["curator:album:detach01"] = { filePath: "/x.mp4" };

    const app = server();
    const res = await app.inject({
      method: "POST",
      url: "/api/albums/detach01/detach-video",
    });
    expect(res.statusCode).toBe(200);
    expect(backdrop.entries["curator:album:detach01"]).toBeUndefined();
  });

  it("deleting an album removes it from Backdrop", async () => {
    store.save(withVideo("del00001"));
    backdrop.entries["curator:album:del00001"] = { filePath: "/x.mp4" };
    const res = await server().inject({
      method: "DELETE",
      url: "/api/albums/del00001",
    });
    expect(res.statusCode).toBe(200);
    expect(backdrop.entries["curator:album:del00001"]).toBeUndefined();
  });

  it("POST /api/backdrop/sync reconciles the whole library", async () => {
    store.save(withVideo("resy0001"));
    // syncMediaLocally is on, so the mp4 must exist on disk for the transfer to succeed.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(store.paths.visualizerFile("resy0001"), Buffer.from("MP4"));
    const res = await server().inject({
      method: "POST",
      url: "/api/backdrop/sync",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushed).toBe(1);
    expect(backdrop.entries["curator:album:resy0001"]).toBeTruthy();
  });

  it("POST /api/backdrop/verify-sync reports drift", async () => {
    store.save(withVideo("veri0001"));
    const res = await server().inject({
      method: "POST",
      url: "/api/backdrop/verify-sync",
    });
    expect(res.json()).toEqual({
      ok: false,
      discrepancies: ["curator:album:veri0001 not in the library"],
    });
  });

  it("backdrop routes 409 when no Backdrop is configured", async () => {
    const app = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
    }).app;
    const status = await app.inject({
      method: "GET",
      url: "/api/backdrop/status",
    });
    // `mediaTransfer` is reported so "will a sync move my videos?" doesn't require reading .env (#187).
    expect(status.json()).toEqual({ enabled: false, mediaTransfer: "none" });
    const resync = await app.inject({
      method: "POST",
      url: "/api/backdrop/sync",
    });
    expect(resync.statusCode).toBe(409);
  });
});
