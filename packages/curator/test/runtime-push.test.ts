import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";
import type { AlbumAsset } from "../src/albums/asset.js";

const SECRET = "s3cr3t";

/** A stand-in Conductor exposing just the album-asset ingest surface (ADR 0045). */
function stubConductor() {
  const assets: Record<string, unknown> = {};
  const app = Fastify();
  app.put("/api/album-assets/:curatorId", async (req) => {
    const { curatorId } = req.params as { curatorId: string };
    assets[curatorId] = req.body;
    return { curatorId, bytes: 1 };
  });
  app.get("/api/album-assets", async () => ({
    curatorIds: Object.keys(assets).sort(),
  }));
  return { app, assets };
}

const awaitingVerify = (id: string): AlbumAsset => {
  const a = makeAsset(id);
  a.roadie.state = "awaiting_verify";
  a.roadie.history = [{ state: "awaiting_verify", at: a.createdAt }];
  return a;
};

describe("runtime push — Curator is the one place data leaves the workstation", () => {
  let conductor: ReturnType<typeof stubConductor>;
  let url: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubConductor();
    await conductor.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = conductor.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-push-")));
  });
  afterEach(async () => {
    await conductor.app.close();
  });

  const server = (pushAssets = true) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: {
        conductor: { url, sharedSecret: SECRET, pushAssets },
      },
    }).app;

  const awaitJob = async (
    app: ReturnType<typeof server>,
    id: string,
  ): Promise<{ status: string; result?: Record<string, unknown> }> => {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
      const job = res.json();
      if (job.status !== "running") return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("runtime sync job did not finish");
  };

  describe("POST /api/albums/:curatorId/push", () => {
    it("puts the album's asset on the runtime", async () => {
      store.save(makeAsset("push0001"));
      const res = await server().inject({
        method: "POST",
        url: "/api/albums/push0001/push",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conductor).toMatchObject({ ok: true });
      expect(conductor.assets["push0001"]).toMatchObject({
        curatorId: "push0001",
      });
    });

    it("404s for an album that doesn't exist", async () => {
      const res = await server().inject({
        method: "POST",
        url: "/api/albums/nosuch01/push",
      });
      expect(res.statusCode).toBe(404);
    });

    // The reason this route exists at all: `verified` is terminal, so verify-physical can't be the
    // only way to push, or a re-attached video on a verified album would need a shell again.
    it("still works on an already-verified album", async () => {
      const a = makeAsset("done0001");
      a.roadie.state = "verified";
      a.roadie.history = [{ state: "verified", at: a.createdAt }];
      store.save(a);
      const res = await server().inject({
        method: "POST",
        url: "/api/albums/done0001/push",
      });
      expect(res.statusCode).toBe(200);
      expect(conductor.assets["done0001"]).toBeTruthy();
    });

    it("reports the leg as skipped rather than failing when no push is configured", async () => {
      store.save(makeAsset("noconf01"));
      const res = await server(false).inject({
        method: "POST",
        url: "/api/albums/noconf01/push",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conductor).toMatchObject({ ok: true, skipped: true });
      expect(conductor.assets["noconf01"]).toBeUndefined();
    });

    it("records an unreachable runtime as a syncIssue instead of failing the request", async () => {
      store.save(makeAsset("unrea001"));
      const app = buildServer({
        store,
        roadie: fakeRoadie(store),
        prober: fakeProber(),
        config: { conductor: { url: "http://127.0.0.1:1", pushAssets: true } },
      }).app;
      const res = await app.inject({
        method: "POST",
        url: "/api/albums/unrea001/push",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conductor.ok).toBe(false);
      expect(store.read("unrea001")!.roadie.syncIssues[0]).toMatch(
        /^Conductor: push failed/,
      );
    });
  });

  describe("POST /api/albums/:curatorId/verify-physical", () => {
    it("pushes the album before marking it verified", async () => {
      store.save(awaitingVerify("veri0001"));
      const res = await server().inject({
        method: "POST",
        url: "/api/albums/veri0001/verify-physical",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe("verified");
      expect(res.json().push.conductor).toMatchObject({ ok: true });
      expect(conductor.assets["veri0001"]).toBeTruthy();
    });

    it("still verifies when the runtime is unreachable — the push is best-effort", async () => {
      store.save(awaitingVerify("veri0002"));
      const app = buildServer({
        store,
        roadie: fakeRoadie(store),
        prober: fakeProber(),
        config: { conductor: { url: "http://127.0.0.1:1", pushAssets: true } },
      }).app;
      const res = await app.inject({
        method: "POST",
        url: "/api/albums/veri0002/verify-physical",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe("verified");
      expect(res.json().push.conductor.ok).toBe(false);
    });
  });

  describe("POST /api/runtime/sync", () => {
    it("returns 202 with a library-scoped job, then pushes every album", async () => {
      for (const id of ["sync0001", "sync0002", "sync0003"])
        store.save(makeAsset(id));
      const app = server();
      const res = await app.inject({
        method: "POST",
        url: "/api/runtime/sync",
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().kind).toBe("runtimeSync");
      expect(res.json().curatorId).toBeUndefined(); // library-scoped (ADR 0029)

      const job = await awaitJob(app, res.json().id);
      expect(job.status).toBe("done");
      expect(job.result!.runtimeSync).toMatchObject({
        conductor: { pushed: 3, failures: [] },
      });
      expect(Object.keys(conductor.assets).sort()).toEqual([
        "sync0001",
        "sync0002",
        "sync0003",
      ]);
    });

    // Progress is one tick per album per *enabled* service. No Backdrop is configured here, so a
    // total of 2×albums would leave the bar permanently half-finished.
    it("counts only the legs that are actually configured", async () => {
      for (const id of ["legs0001", "legs0002"]) store.save(makeAsset(id));
      const app = server();
      const started = await app.inject({
        method: "POST",
        url: "/api/runtime/sync",
      });
      const done = await awaitJob(app, started.json().id);
      expect(
        (done as { progress: { done: number; total: number } }).progress,
      ).toEqual({ done: 2, total: 2 });
    });

    it("409s when nothing is configured to push to", async () => {
      const res = await server(false).inject({
        method: "POST",
        url: "/api/runtime/sync",
      });
      expect(res.statusCode).toBe(409);
    });

    it("is cancellable — the whole reason it's a job and not a request", async () => {
      for (const id of ["canc0001", "canc0002"]) store.save(makeAsset(id));
      const app = server();
      const started = await app.inject({
        method: "POST",
        url: "/api/runtime/sync",
      });
      const cancelled = await app.inject({
        method: "POST",
        url: `/api/jobs/${started.json().id}/cancel`,
      });
      expect(cancelled.json().status).toBe("cancelled");
    });
  });

  describe("POST /api/runtime/verify", () => {
    it("reports albums the runtime has never been given", async () => {
      store.save(makeAsset("have0001"));
      store.save(makeAsset("miss0001"));
      const app = server();
      await app.inject({ method: "POST", url: "/api/albums/have0001/push" });

      const res = await app.inject({
        method: "POST",
        url: "/api/runtime/verify",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conductor).toMatchObject({
        ok: false,
        missing: ["miss0001"],
        extra: [],
      });
    });

    it("reports an unreachable runtime rather than erroring", async () => {
      store.save(makeAsset("unrea002"));
      const app = buildServer({
        store,
        roadie: fakeRoadie(store),
        prober: fakeProber(),
        config: { conductor: { url: "http://127.0.0.1:1", pushAssets: true } },
      }).app;
      const res = await app.inject({
        method: "POST",
        url: "/api/runtime/verify",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conductor.ok).toBe(false);
      expect(res.json().conductor.error).toBeTruthy();
    });
  });

  describe("GET /api/jobs/active", () => {
    it("answers 'what is this machine doing' without being told a kind", async () => {
      for (const id of ["actv0001", "actv0002"]) store.save(makeAsset(id));
      const app = server();
      await app.inject({ method: "POST", url: "/api/runtime/sync" });
      const res = await app.inject({ method: "GET", url: "/api/jobs/active" });
      expect(res.statusCode).toBe(200);
      const kinds = (res.json().jobs as Array<{ kind: string }>).map(
        (j) => j.kind,
      );
      expect(kinds).toContain("runtimeSync");
    });

    it("lists nothing once everything has settled", async () => {
      store.save(makeAsset("idle0001"));
      const app = server();
      const started = await app.inject({
        method: "POST",
        url: "/api/runtime/sync",
      });
      await awaitJob(app, started.json().id);
      const res = await app.inject({ method: "GET", url: "/api/jobs/active" });
      expect(res.json().jobs).toEqual([]);
    });
  });
});
