import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { ConductorClient } from "../src/conductor/client.js";
import { ConductorSync } from "../src/conductor/sync.js";
import { makeAsset } from "./helpers.js";

const SECRET = "s3cr3t";

/** A stand-in Conductor: the real album-asset ingest surface, in memory, enforcing auth. */
function stubConductor(secret: string | null = SECRET) {
  const assets: Record<string, unknown> = {};
  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (secret && req.headers["x-trigger-secret"] !== secret)
      await reply.code(401).send({ error: "unauthorized" });
  });
  app.put("/api/album-assets/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const body = req.body as { curatorId?: string };
    if (body?.curatorId !== curatorId)
      return reply.code(400).send({ error: "curatorId does not match" });
    assets[curatorId] = body;
    return { curatorId, bytes: JSON.stringify(body).length };
  });
  app.get("/api/album-assets", async () => ({
    curatorIds: Object.keys(assets).sort(),
  }));
  return { app, assets };
}

describe("ConductorSync → Conductor (real HTTP)", () => {
  let conductor: ReturnType<typeof stubConductor>;
  let url: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubConductor();
    await conductor.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = conductor.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-csync-")));
  });
  afterEach(async () => {
    await conductor.app.close();
  });

  const sync = (base = url) =>
    new ConductorSync({
      store,
      clients: [new ConductorClient({ url: base, sharedSecret: SECRET })],
    });

  const dead = () =>
    new ConductorSync({
      store,
      clients: [
        new ConductorClient({
          url: "http://127.0.0.1:1",
          sharedSecret: SECRET,
          timeoutMs: 500,
        }),
      ],
    });

  it("pushes the whole asset with the shared secret", async () => {
    store.save(makeAsset("abc12345"));
    const res = await sync().syncAlbum(store.read("abc12345")!);
    expect(res.ok).toBe(true);
    expect(conductor.assets["abc12345"]).toMatchObject({
      curatorId: "abc12345",
      version: 1,
    });
  });

  it("fails without the shared secret rather than pretending to succeed", async () => {
    store.save(makeAsset("noauth01"));
    const noSecret = new ConductorSync({
      store,
      clients: [new ConductorClient({ url })],
    });
    const res = await noSecret.syncAlbum(store.read("noauth01")!);
    expect(res.ok).toBe(false);
    expect(conductor.assets["noauth01"]).toBeUndefined();
  });

  it("records an unreachable Conductor as a syncIssue on the album", async () => {
    store.save(makeAsset("dead0001"));
    const res = await dead().syncAlbum(store.read("dead0001")!);
    expect(res.ok).toBe(false);
    const issues = store.read("dead0001")!.roadie.syncIssues;
    expect(issues[0]).toMatch(/^Conductor: push failed/);
    // It surfaces in the derived status the queue view renders.
    expect(store.read("dead0001")!.status.issues).toContain(issues[0]);
  });

  it("clears its own syncIssue once a later push succeeds", async () => {
    const a = makeAsset("recover1");
    a.roadie.syncIssues = ["Conductor: push failed: old"];
    store.save(a);
    await sync().syncAlbum(store.read("recover1")!);
    expect(store.read("recover1")!.roadie.syncIssues).toEqual([]);
  });

  // The regression this file exists for: two services write one `syncIssues` array, and a naive
  // wholesale replace made each erase the other's findings.
  it("leaves Backdrop's issues alone when it records its own", async () => {
    const a = makeAsset("shared01");
    a.roadie.syncIssues = ["Backdrop: sync failed: video never landed"];
    store.save(a);
    await dead().syncAlbum(store.read("shared01")!);
    const issues = store.read("shared01")!.roadie.syncIssues;
    expect(issues).toHaveLength(2);
    expect(issues).toContain("Backdrop: sync failed: video never landed");
    expect(issues.some((i) => i.startsWith("Conductor: "))).toBe(true);
  });

  it("leaves Backdrop's issues alone when it clears its own", async () => {
    const a = makeAsset("shared02");
    a.roadie.syncIssues = [
      "Backdrop: sync failed: video never landed",
      "Conductor: push failed: stale",
    ];
    store.save(a);
    await sync().syncAlbum(store.read("shared02")!);
    expect(store.read("shared02")!.roadie.syncIssues).toEqual([
      "Backdrop: sync failed: video never landed",
    ]);
  });

  describe("resyncAll", () => {
    it("pushes every album and counts them", async () => {
      for (const id of ["aaaa1111", "bbbb2222", "cccc3333"])
        store.save(makeAsset(id));
      const res = await sync().resyncAll(store.list());
      expect(res.pushed).toBe(3);
      expect(res.failures).toEqual([]);
      expect(Object.keys(conductor.assets).sort()).toEqual([
        "aaaa1111",
        "bbbb2222",
        "cccc3333",
      ]);
    });

    it("reports progress so a long run can be watched", async () => {
      for (const id of ["aaaa1111", "bbbb2222"]) store.save(makeAsset(id));
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

    it("keeps going past one album's failure instead of stranding the rest", async () => {
      for (const id of ["aaaa1111", "bbbb2222"]) store.save(makeAsset(id));
      // Reject exactly one album, leaving the others pushable.
      const s = new ConductorSync({
        store,
        clients: [
          new ConductorClient({
            url,
            sharedSecret: SECRET,
            fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
              String(input).endsWith("/aaaa1111")
                ? Promise.resolve(new Response("nope", { status: 500 }))
                : fetch(input as string, init)) as typeof fetch,
          }),
        ],
      });
      const res = await s.resyncAll(store.list());
      expect(res.pushed).toBe(1);
      expect(res.failures).toHaveLength(1);
      expect(res.failures[0]!.curatorId).toBe("aaaa1111");
      expect(conductor.assets["bbbb2222"]).toBeDefined();
    });

    it("stops between albums when cancelled, leaving what it already pushed", async () => {
      for (const id of ["aaaa1111", "bbbb2222", "cccc3333"])
        store.save(makeAsset(id));
      const ac = new AbortController();
      const s = sync();
      const res = await s.resyncAll(store.list(), {
        onProgress: (done) => {
          if (done === 1) ac.abort();
        },
        signal: ac.signal,
      });
      expect(res.pushed).toBe(1);
      expect(Object.keys(conductor.assets)).toEqual(["aaaa1111"]);
    });
  });

  describe("verify", () => {
    it("reports albums the runtime has never seen", async () => {
      store.save(makeAsset("here0001"));
      store.save(makeAsset("gone0002"));
      await sync().syncAlbum(store.read("here0001")!);
      const res = await sync().verify(store.list());
      expect(res.ok).toBe(false);
      expect(res.missing).toEqual(["gone0002"]);
      expect(res.extra).toEqual([]);
    });

    it("reports leftovers on the runtime, since the push never deletes", async () => {
      store.save(makeAsset("here0001"));
      await sync().syncAlbum(store.read("here0001")!);
      conductor.assets["deleted1"] = { curatorId: "deleted1" };
      const res = await sync().verify(store.list());
      expect(res.ok).toBe(true); // extras cannot break playback
      expect(res.extra).toEqual(["deleted1"]);
    });

    it("is ok when both stores agree", async () => {
      store.save(makeAsset("here0001"));
      await sync().syncAlbum(store.read("here0001")!);
      expect(await sync().verify(store.list())).toMatchObject({
        ok: true,
        missing: [],
        extra: [],
      });
    });
  });

  /**
   * **More than one host reads the album-assets store, so the push has more than one target**
   * ([ADR 0079](../../../docs/adrs/0079-the-asset-push-has-more-than-one-target.md) / [#306](https://github.com/dylanleatham/Marquee/issues/306)).
   *
   * The deployment that broke: a desktop shell running its own Conductor over Curator's data dir,
   * *and* a Pi running Conductor + Amp over a copy of it. One `conductor.url` could name only one of
   * them, the shell pinned it at itself, and the Pi went four days without a write while
   * `POST /api/runtime/sync` answered `pushed: 478, failures: []` every time.
   *
   * So the properties here are about reach and about honesty: every target gets the asset, one
   * unreachable target cannot swallow the others, and nothing counts as pushed until all of them
   * have it.
   */
  describe("more than one target", () => {
    let second: ReturnType<typeof stubConductor>;
    let secondUrl: string;

    beforeEach(async () => {
      second = stubConductor();
      await second.app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = second.app.server.address() as AddressInfo;
      secondUrl = `http://127.0.0.1:${port}`;
    });
    afterEach(async () => {
      await second.app.close();
    });

    const both = (...urls: string[]) =>
      new ConductorSync({
        store,
        clients: urls.map(
          (u) =>
            new ConductorClient({
              url: u,
              sharedSecret: SECRET,
              timeoutMs: 500,
            }),
        ),
      });

    it("puts the asset on every target", async () => {
      store.save(makeAsset("multi001"));
      const res = await both(url, secondUrl).syncAlbum(store.read("multi001")!);

      expect(res.ok).toBe(true);
      expect(conductor.assets["multi001"]).toMatchObject({
        curatorId: "multi001",
      });
      expect(second.assets["multi001"]).toMatchObject({
        curatorId: "multi001",
      });
    });

    /**
     * The Pi being off must not cost the workstation its copy, and — the actual #306 failure — a
     * reachable target must not make an unreachable one look fine. The issue names the host, because
     * "push failed" without one is unactionable when there are two.
     */
    it("still reaches the live target when another is down, and names the one that failed", async () => {
      store.save(makeAsset("halfup01"));
      const res = await both(url, "http://127.0.0.1:1").syncAlbum(
        store.read("halfup01")!,
      );

      expect(res.ok).toBe(false);
      expect(conductor.assets["halfup01"]).toBeDefined();
      const issues = store.read("halfup01")!.roadie.syncIssues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^Conductor: push failed/);
      expect(issues[0]).toContain("http://127.0.0.1:1");
      // …and not the one that worked, or the message sends you to the wrong machine.
      expect(issues[0]).not.toContain(url);
    });

    it("counts an album as pushed only once every target holds it", async () => {
      for (const id of ["reach001", "reach002"]) store.save(makeAsset(id));
      const res = await both(url, "http://127.0.0.1:1").resyncAll(store.list());

      expect(res.pushed).toBe(0);
      expect(res.failures).toHaveLength(2);
      // The per-target breakdown is what makes "pushed: 478" checkable rather than reassuring.
      expect(res.targets).toEqual([
        { url, pushed: 2, failed: 0 },
        { url: "http://127.0.0.1:1", pushed: 0, failed: 2 },
      ]);
    });

    it("counts a target's own progress when every target is up", async () => {
      store.save(makeAsset("allup001"));
      const res = await both(url, secondUrl).resyncAll(store.list());

      expect(res.pushed).toBe(1);
      expect(res.failures).toEqual([]);
      expect(res.targets).toEqual([
        { url, pushed: 1, failed: 0 },
        { url: secondUrl, pushed: 1, failed: 0 },
      ]);
    });

    /** An album on one runtime and not the other is missing — "everywhere it should be" is the claim. */
    it("verifies against every target and reports which one is short", async () => {
      store.save(makeAsset("onlyon01"));
      await both(url).syncAlbum(store.read("onlyon01")!);

      const res = await both(url, secondUrl).verify(store.list());
      expect(res.ok).toBe(false);
      expect(res.missing).toEqual(["onlyon01"]);
      expect(res.targets).toEqual([
        { url, ok: true, missing: [], extra: [] },
        { url: secondUrl, ok: false, missing: ["onlyon01"], extra: [] },
      ]);
    });

    it("reports an unreachable target as its own failure rather than as drift", async () => {
      store.save(makeAsset("noverif1"));
      await both(url).syncAlbum(store.read("noverif1")!);

      const res = await both(url, "http://127.0.0.1:1").verify(store.list());
      expect(res.ok).toBe(false);
      // Not listed as `missing`: we do not know what that host holds, and saying "missing" would
      // send someone to re-push a store that may already be complete.
      expect(res.missing).toEqual([]);
      expect(res.targets[1]!.error).toBeTruthy();
    });
  });
});
