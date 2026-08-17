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
import { createFakeSpotify } from "@marquee/fake-spotify";
import { createFakeDiscogs } from "@marquee/fake-discogs";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { DiscogsClient } from "../src/discogs/client.js";
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
  // `usesDefault` is the shape a record with no visualizer of its own projects as (ADR 0073), and
  // the stub mirrors the real route's *replace* semantics for it — merging would keep the filePath a
  // detach just removed, which is the bug this stub would otherwise hide.
  const entries: Record<
    string,
    {
      filePath?: string;
      usesDefault?: boolean;
      durationSec?: number;
      contentHash?: string;
    }
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
      filePath?: string;
      usesDefault?: boolean;
      durationSec?: number;
      contentHash?: string;
    };
    received.push({ method: "POST", path: "/api/library/update", body: b });
    entries[b.uri] = b.usesDefault
      ? { usesDefault: true }
      : {
          filePath: b.filePath,
          durationSec: b.durationSec,
          ...(b.contentHash ? { contentHash: b.contentHash } : {}),
        };
    return { updated: b.uri };
  });
  app.post("/api/library/sync", async (req) => {
    const b = req.body as {
      entries: Array<{
        uri: string;
        filePath?: string;
        usesDefault?: boolean;
        contentHash?: string;
      }>;
    };
    received.push({ method: "POST", path: "/api/library/sync", body: b });
    for (const k of Object.keys(entries)) delete entries[k];
    for (const e of b.entries)
      entries[e.uri] = e.usesDefault
        ? { usesDefault: true }
        : {
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

  /**
   * ADR 0073. A detach used to DELETE the entry, which left Backdrop unable to tell an unfinished
   * record from a tag nothing knows — both answered `video not in library`. It now rewrites the
   * entry to `usesDefault`, so the record still plays something and the not-in-library indicator
   * goes on meaning what it says.
   */
  it("rewrites the entry to usesDefault when an album has no video, instead of removing it", async () => {
    backdrop.entries["curator:album:novid123"] = { filePath: "/stale.mp4" };
    const res = await sync().syncAlbum(makeAsset("novid123"));
    expect(res.ok).toBe(true);
    expect(backdrop.entries["curator:album:novid123"]).toEqual({
      usesDefault: true,
    });
    expect(backdrop.received.at(-1)!.method).toBe("POST");
  });

  // The stale filePath is the whole risk of a detach: left behind, Backdrop keeps playing the video
  // the user deliberately took away.
  it("a detach clears the filePath Backdrop was holding", async () => {
    store.save(withVideo("detachx1"));
    await sync().syncAlbum(store.read("detachx1")!);
    expect(backdrop.entries["curator:album:detachx1"]!.filePath).toBeTruthy();

    const detached = store.read("detachx1")!;
    delete detached.visualizer;
    await sync().syncAlbum(detached);

    expect(backdrop.entries["curator:album:detachx1"]).toEqual({
      usesDefault: true,
    });
  });

  /**
   * The drift ADR 0073 makes possible: Backdrop still holds a `filePath` for a record Curator has
   * since detached. Left there, the runtime keeps playing the video the user took away — and the
   * old check couldn't see it, because it only ever compared entries for albums that *had* a video.
   */
  it("verify flags a detached record Backdrop still holds a file for", async () => {
    backdrop.entries["curator:album:drift001"] = { filePath: "/stale.mp4" };
    const check = await sync().verify([makeAsset("drift001")]);
    expect(check.ok).toBe(false);
    expect(check.discrepancies[0]).toContain("has no visualizer");
    expect(check.discrepancies[0]).toContain("/stale.mp4");
  });

  it("verify accepts a detached record Backdrop holds as usesDefault", async () => {
    backdrop.entries["curator:album:drift002"] = { usesDefault: true };
    const check = await sync().verify([makeAsset("drift002")]);
    expect(check).toEqual({ ok: true, discrepancies: [] });
  });

  // The mirror image: Backdrop is still on the fallback for a record that now has a visualizer.
  it("verify flags a videoed record Backdrop still holds as usesDefault", async () => {
    store.save(withVideo("drift003"));
    backdrop.entries["curator:album:drift003"] = { usesDefault: true };
    const check = await sync().verify([store.read("drift003")!]);
    expect(check.ok).toBe(false);
    expect(check.discrepancies[0]).toContain("filePath drift");
    expect(check.discrepancies[0]).toContain("the default visualizer");
  });

  // A record with no visualizer that Backdrop has never heard of is still a real discrepancy —
  // projecting every album is only useful if `verify` notices when the projection didn't land.
  it("verify flags a record with no visualizer that never reached Backdrop", async () => {
    const check = await sync().verify([makeAsset("drift004")]);
    expect(check.ok).toBe(false);
    expect(check.discrepancies[0]).toContain("not in the library");
  });

  it("verifyAlbum records the stale-filePath drift as a syncIssue on the record", async () => {
    store.save(makeAsset("drift005"));
    backdrop.entries["curator:album:drift005"] = { filePath: "/stale.mp4" };
    await sync().verifyAlbum(store.read("drift005")!);
    expect(store.read("drift005")!.roadie.syncIssues[0]).toContain(
      "has no visualizer",
    );
  });

  it("syncMetadata owes no file transfer for a record with no visualizer", async () => {
    const res = await sync({ local: true }).syncMetadata(makeAsset("nofile01"));
    expect(res.ok).toBe(true);
    expect(res.transferNeeded).toBe(false);
    expect(backdrop.entries["curator:album:nofile01"]).toEqual({
      usesDefault: true,
    });
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

  // ADR 0073: a record with no visualizer of its own is still a record Backdrop should know about,
  // so it goes in the reconcile as `usesDefault`. It used to be dropped, which is how a `sync` could
  // report success and still leave half the collection unknown to the runtime.
  it("resyncAll replaces the whole library with every album, videoed or not", async () => {
    store.save(withVideo("has0vid1"));
    store.save(makeAsset("no0video"));
    backdrop.entries["curator:album:stale999"] = { filePath: "/gone.mp4" };
    const result = await sync().resyncAll(store.list());
    expect(result.pushed).toBe(2);
    expect(Object.keys(backdrop.entries).sort()).toEqual([
      "curator:album:has0vid1",
      "curator:album:no0video",
    ]);
    expect(backdrop.entries["curator:album:no0video"]).toEqual({
      usesDefault: true,
    });
  });

  // Counted as neither transferred nor unchanged: there are no bytes to move. Conflating the two
  // is what made `{"pushed":12}` mean both "uploaded everything" and "moved nothing" (issue #187).
  it("resyncAll moves no bytes for a record with no visualizer", async () => {
    store.save(makeAsset("nobytes1"));
    const result = await sync({ local: true }).resyncAll(store.list());
    expect(result.media).toEqual({
      transferred: 0,
      unchanged: 0,
      skipped: 0,
    });
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

  // Issue #268. The album counter and the byte counter used to be the same function: `resyncAll`
  // forwarded its whole `ctx` down to `copyVisualizer`, whose contract includes `onProgress`, so a
  // running sync reported `24248819/998` — bytes of the file in flight against a total counted in
  // albums. `transferMedia`'s parameter type says `{ signal }` alone, which read as a guarantee and
  // was not one: a *variable* assigned to a narrower parameter keeps its extra properties.
  //
  // The progress test above cannot catch this — it builds the sync with no `mediaTransfer`, so the
  // transfer returns early and the two units never meet. This is the same assertion on the push path.
  it("resyncAll keeps progress album-counted while the transfer reports bytes", async () => {
    for (const id of ["bytes001", "bytes002"]) store.save(withVideo(id));
    mkdirSync(store.paths.visualizers, { recursive: true });
    for (const id of ["bytes001", "bytes002"])
      writeFileSync(store.paths.visualizerFile(id), Buffer.from("MP4"));

    const pushSync = new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: mediaDir,
      mediaTransfer: {
        mode: "push",
        // What the real HTTP push does (`BackdropClient.putMedia`): bytes sent of bytes total.
        async copyVisualizer(_src, _fileId, ctx) {
          ctx?.onProgress?.(5_000_000, 66_000_000);
          ctx?.onProgress?.(66_000_000, 66_000_000);
        },
      },
    });

    const seen: Array<[number, number]> = [];
    await pushSync.resyncAll(store.list(), {
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  // Issue #274. The album counter advances once per album, so a single large visualizer over a poor
  // link is indistinguishable from a wedged sync while it uploads. `onTransfer` is the byte channel
  // that tells them apart — separate from `onProgress` by construction, per #268.
  it("resyncAll reports the file in flight in bytes, and clears it after", async () => {
    const a = withVideo("xfer0001");
    a.metadata.name = "Kind of Blue";
    store.save(a);
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(store.paths.visualizerFile("xfer0001"), Buffer.from("MP4"));

    const seen: Array<{ label: string; sent: number; total: number } | null> =
      [];
    const albumTicks: Array<[number, number]> = [];
    const pushSync = new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: mediaDir,
      mediaTransfer: {
        mode: "push",
        async copyVisualizer(_src, _fileId, ctx) {
          ctx?.onProgress?.(5_000_000, 66_000_000);
          ctx?.onProgress?.(66_000_000, 66_000_000);
        },
      },
    });

    await pushSync.resyncAll(store.list(), {
      onProgress: (done, total) => albumTicks.push([done, total]),
      onTransfer: (t) => seen.push(t),
    });

    expect(seen).toEqual([
      { label: "Kind of Blue", sent: 5_000_000, total: 66_000_000 },
      { label: "Kind of Blue", sent: 66_000_000, total: 66_000_000 },
      null, // cleared once the file is done — a stale count would read as still uploading
    ]);
    // And the two units still do not touch: the album counter saw only album numbers.
    expect(albumTicks).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("resyncAll clears the file in flight even when the upload throws", async () => {
    const a = withVideo("xfer0002");
    store.save(a);
    mkdirSync(store.paths.visualizers, { recursive: true });
    writeFileSync(store.paths.visualizerFile("xfer0002"), Buffer.from("MP4"));

    const seen: Array<{ label: string } | null> = [];
    const failing = new BackdropSync({
      store,
      client: new BackdropClient({ url, sharedSecret: SECRET }),
      backdropMediaDir: mediaDir,
      mediaTransfer: {
        mode: "push",
        async copyVisualizer(_src, _fileId, ctx) {
          ctx?.onProgress?.(1_000, 66_000_000);
          throw new Error("upload stalled for 60000ms");
        },
      },
    });

    const res = await failing.resyncAll(store.list(), {
      onTransfer: (t) => seen.push(t),
    });

    expect(res.failures).toHaveLength(1);
    // The last thing the page hears is that nothing is moving — not a frozen byte count.
    expect(seen.at(-1)).toBeNull();
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

  const server = (extra: Partial<Parameters<typeof buildServer>[0]> = {}) =>
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
      ...extra,
    }).app;

  /** A server whose Spotify adds resolve against a fake, for the add-path triggers. */
  const spotifyServer = (id: string) => {
    const fake = createFakeSpotify([
      {
        id,
        name: "Cherry Bomb",
        artist: { id: "tyler1", name: "Tyler, The Creator" },
        year: 2015,
        genres: ["hip hop"],
        artwork: Buffer.from("IMG"),
      },
    ]);
    return server({
      spotify: new SpotifyClient({
        clientId: "id",
        clientSecret: "s",
        fetch: fake.fetch,
      }),
    });
  };

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

    // Let anything still running settle. The entry must stay on the default (ADR 0073) — a
    // resurrected filePath is exactly the video the user took away.
    await awaitTransfers(app, "detach99");
    expect(backdrop.entries["curator:album:detach99"]).toEqual({
      usesDefault: true,
    });
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

  it("detaching the video drops Backdrop's filePath and leaves the record on the default", async () => {
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
    // Not removed (ADR 0073): the record is still ours, it just has no visualizer again.
    expect(backdrop.entries["curator:album:detach01"]).toEqual({
      usesDefault: true,
    });
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

  /**
   * ★sync-on-add ([#343](https://github.com/dylanleatham/Marquee/issues/343)).
   *
   * Adding an album *is* a projection change now. Under ADR 0073 every album Curator holds projects
   * as an entry — `usesDefault` until it has a visualizer — so the entry appears the moment the album
   * does. Before that ADR a video-less album projected as `null` and there was genuinely nothing to
   * push, which is why [ADR 0015](../../../docs/adrs/0015-backdrop-sync-triggered-at-projection-changes.md)'s
   * trigger list starts at video attach.
   *
   * Leaving it there meant a record added since the last full reconcile was unknown to Backdrop, so
   * putting it on the stand played nothing and flashed `video not in library` — the mis-written-tag
   * indicator, back to meaning two things, which is the exact confusion ADR 0073 removed.
   */
  const addedEntry = (curatorId: string) =>
    backdrop.entries[`curator:album:${curatorId}`];

  it("adding a manual album puts it in Backdrop's library, on the default", async () => {
    const mp = buildMultipart(
      { name: "Riot!", artist: "Paramore" },
      {
        field: "artwork",
        filename: "cover.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("JPEGBYTES"),
      },
    );
    const res = await server().inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });

    expect(res.statusCode).toBe(201);
    // No visualizer yet, so the record plays the shared default clip rather than nothing.
    expect(addedEntry(res.json().curatorId)).toEqual({ usesDefault: true });
  });

  it("adding a Spotify album puts it in Backdrop's library", async () => {
    const res = await spotifyServer("1C2h7mLntPSeVYciMRTF4a").inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyUri: "spotify:album:1C2h7mLntPSeVYciMRTF4a" },
    });

    expect(res.statusCode).toBe(201);
    // A Spotify add is queued with empty name/artist until Roadie fetches them — and the entry is
    // still correct, because Backdrop's projection is `{ uri, usesDefault }` and carries no metadata
    // at all. That is exactly why the announce can happen at creation rather than at the end of the
    // pipeline.
    expect(addedEntry(res.json().curatorId)).toEqual({ usesDefault: true });
  });

  it("adding a Discogs album puts it in Backdrop's library", async () => {
    const fake = createFakeDiscogs([
      {
        id: 4242,
        title: "Riot!",
        artist: "Paramore",
        year: 2007,
        genres: ["Rock"],
        styles: ["Emo"],
        artwork: Buffer.from("IMG"),
      },
    ]);
    const app = server({
      discogs: new DiscogsClient({
        token: "t",
        fetch: fake.fetch,
        minIntervalMs: 0,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { releaseId: 4242, title: "Riot!", artist: "Paramore" },
    });

    expect(res.statusCode).toBe(201);
    expect(addedEntry(res.json().curatorId)).toEqual({ usesDefault: true });
  });

  it("a pasted batch puts every album in Backdrop's library", async () => {
    const ids = ["AAA111", "BBB222", "CCC333"];
    const fake = createFakeSpotify(
      ids.map((id) => ({
        id,
        name: id,
        artist: { id: "a", name: "A" },
        year: 2000,
        genres: [],
        artwork: Buffer.from("IMG"),
      })),
    );
    const app = server({
      spotify: new SpotifyClient({
        clientId: "id",
        clientSecret: "s",
        fetch: fake.fetch,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/batch",
      payload: {
        items: ids.map((id) => ({
          mode: "spotify",
          spotifyUri: `spotify:album:${id}`,
        })),
      },
    });

    expect(res.statusCode).toBe(200);
    const { curatorIds } = res.json() as { curatorIds: string[] };
    expect(curatorIds).toHaveLength(3);
    // Every line of the paste, not just the first — a partial announce would leave a shelf where
    // some records play and some do not, with nothing to tell them apart.
    for (const id of curatorIds)
      expect(addedEntry(id)).toEqual({ usesDefault: true });
  });

  /**
   * The announce is best-effort (ADR 0015 §3). A Pi that is off must not turn a successful add into
   * a 500 — the album is already saved and queued by then, so failing the request would report "not
   * added" for a record that was, and the natural retry makes a duplicate.
   */
  it("still adds the album when Backdrop is unreachable", async () => {
    await backdrop.app.close(); // nothing listening on `url` any more
    const mp = buildMultipart(
      { name: "Petal", artist: "Ariana Grande" },
      {
        field: "artwork",
        filename: "cover.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("JPEGBYTES"),
      },
    );

    const res = await server().inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });

    expect(res.statusCode).toBe(201);
    const saved = store.read(res.json().curatorId)!;
    expect(saved).toBeTruthy();
    // And the failure is visible rather than silent — the same syncIssue every other push records.
    expect(saved.roadie.syncIssues?.join(" ")).toMatch(/Backdrop/i);
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
