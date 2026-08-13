import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { applyArtworkOverride } from "../src/albums/artwork.js";
import {
  fakeRoadie,
  fakeProber,
  fakeGenerate,
  makeAsset,
  buildMultipart,
  jpegBytes,
  pngBytes,
} from "./helpers.js";
import { deriveStatus, type AlbumAsset } from "../src/albums/asset.js";

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
      // The palette routes in the edit table below need a generator; every other test here ignores it.
      generate: fakeGenerate,
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

  /**
   * **An edit that changes what the room plays has to reach the room** ([#304](https://github.com/dylanleatham/Marquee/issues/304)).
   *
   * The demo cut was chosen in Curator and never left the workstation: `PUT .../demo-track` wrote
   * `demoTrack` to the local store and returned, so Amp kept reading its synced copy — which had
   * none — and took ADR 0058's documented fallback of playing the whole album. Every demo tag played
   * the record from track 1, and *looked* correct doing it: that fallback is also what a demo tag
   * for an album with no cut is supposed to do, so nothing in the room told the two apart.
   *
   * The table is the rule, and it covers **both halves of the record** — the audio Amp streams and
   * the light show Conductor plays, which had the identical gap for palette edits. A route that
   * edits a field either service reads at scan time belongs in this table on the day it is written;
   * naming today's routes in prose would leave the next one to be found in the room again.
   *
   * Deliberately **not** here, and each for a reason: `palette/reset` (drops the hand-edit flag,
   * which no service reads), `palette/feeling` (stores candidates; nothing plays until one is
   * chosen), and the library sweeps, which end in their own report and are what `POST
   * /api/runtime/sync` exists for.
   */
  describe("an edit that changes what the room plays reaches the room", () => {
    const TRACK = "spotify:track:4pNiE4LCVV74vfIBaUHm1b";
    const ALBUM = "spotify:album:6YUCc2RiXcEKS9ibuZxjt0";
    const RED = [
      { hex: "#B3121B", role: "primary" },
      { hex: "#F2A65A", role: "secondary" },
      { hex: "#1E2A44", role: "accent" },
    ];

    interface Request {
      method: "PUT" | "POST" | "DELETE";
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }

    interface RuntimeEdit {
      /** What a person changed, in the words the UI uses. */
      what: string;
      /** Seeded after the album is saved: an earlier choice, or a file the edit needs on disk. */
      given?: (id: string) => void;
      request: (id: string) => Request;
      /** The successful status this route answers with (201 for the artwork upload). */
      status?: number;
      /** What the runtime must be able to read once the request has returned. */
      pushed: (asset: AlbumAsset) => void;
    }

    const chose = (a: AlbumAsset) => {
      a.demoTrack = {
        spotifyUri: TRACK,
        name: "Sir Duke",
        chosenAt: "2026-08-09T21:36:26.011Z",
      };
    };

    /** The cover on disk, which the palette routes re-extract from. */
    const withCover = (id: string) => {
      mkdirSync(store.paths.artwork, { recursive: true });
      writeFileSync(store.paths.artworkFile(id), jpegBytes());
    };

    const EDITS: RuntimeEdit[] = [
      {
        what: "choosing the cut a demo tag plays (ADR 0058)",
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/demo-track`,
          payload: { track: { spotifyUri: TRACK, name: "Sir Duke" } },
        }),
        pushed: (a) => expect(a.demoTrack).toMatchObject({ spotifyUri: TRACK }),
      },
      {
        what: "clearing the cut, which returns the tag to playing the album",
        given: (id) => store.update(id, chose),
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/demo-track`,
          payload: { track: null },
        }),
        pushed: (a) => expect(a.demoTrack).toBeNull(),
      },
      {
        what: "naming the album on Spotify by hand (ADR 0059)",
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/spotify-uri`,
          payload: { spotifyUri: ALBUM },
        }),
        pushed: (a) => expect(a.metadata.spotifyUri).toBe(ALBUM),
      },
      {
        what: "disowning the album, which also drops the cut chosen from it",
        given: (id) =>
          store.update(id, (a) => {
            a.metadata.spotifyUri = ALBUM;
            chose(a);
          }),
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/spotify-uri`,
          payload: { spotifyUri: null },
        }),
        pushed: (a) => {
          expect(a.metadata.spotifyUri).toBeUndefined();
          expect(a.demoTrack).toBeNull();
        },
      },
      {
        what: "hand-editing the palette (curator-spec §12)",
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/palette`,
          payload: { colors: RED },
        }),
        pushed: (a) =>
          expect(a.palette!.colors.map((c) => c.hex)).toEqual([
            "#B3121B",
            "#F2A65A",
            "#1E2A44",
          ]),
      },
      {
        what: "overriding the motion (ADR 0039)",
        request: (id) => ({
          method: "PUT",
          url: `/api/albums/${id}/pattern-override`,
          payload: { type: "aurora" },
        }),
        pushed: (a) => expect(a.patternOverride).toBe("aurora"),
      },
      {
        what: "choosing one of the proposed palettes (ADR 0030)",
        given: (id) =>
          store.update(id, (a) => {
            a.paletteCandidates = {
              generatedAt: "2026-08-09T00:00:00.000Z",
              rationale: "the record sounds like this",
              cover: a.palette!.colors,
              feeling: RED,
              blend: RED,
            };
          }),
        request: (id) => ({
          method: "POST",
          url: `/api/albums/${id}/palette/choose`,
          payload: { source: "feeling" },
        }),
        pushed: (a) => expect(a.palette!.source).toBe("feeling"),
      },
      {
        what: "re-deriving the palette from the cover",
        given: withCover,
        request: (id) => ({
          method: "POST",
          url: `/api/albums/${id}/palette/generate?force=1`,
        }),
        pushed: (a) => expect(a.palette!.handEdited).toBe(false),
      },
      {
        what: "uploading a cover that replaces the fetched one (issue #100)",
        given: withCover,
        request: (id) => {
          const mp = buildMultipart(
            { regeneratePalette: "true" },
            {
              field: "file",
              filename: "better-scan.png",
              contentType: "image/png",
              data: pngBytes(),
            },
          );
          return {
            method: "POST",
            url: `/api/albums/${id}/artwork/override`,
            headers: { "content-type": mp.contentType },
            payload: mp.body,
          };
        },
        status: 201,
        pushed: (a) => expect(a.artwork!.overrideActive).toBe(true),
      },
      {
        what: "dropping that override, which re-derives from the fetched cover",
        given: (id) => {
          withCover(id);
          applyArtworkOverride(store, id, pngBytes());
        },
        request: (id) => ({
          method: "DELETE",
          url: `/api/albums/${id}/artwork/override`,
        }),
        pushed: (a) => expect(a.artwork!.overrideActive).toBe(false),
      },
    ];

    const seed = (id: string, given?: (id: string) => void) => {
      const asset = makeAsset(id);
      // Verified: the state these edits are actually made in. A record is set up, put on the shelf,
      // and *then* someone picks its demo cut — long after the verify that used to be the last push.
      asset.roadie.state = "verified";
      asset.roadie.history = [{ state: "verified", at: asset.createdAt }];
      // Derived, not hand-set: `status` is a projection of `roadie`, and leaving it stale here would
      // make the pushed copy differ from the stored one for a reason that is the seeding's fault.
      asset.status = deriveStatus(asset.roadie);
      store.save(asset);
      given?.(id);
    };

    EDITS.forEach((edit, i) => {
      const id = `edit00${String(i).padStart(2, "0")}`;

      it(`pushes the album after ${edit.what}`, async () => {
        seed(id, edit.given);

        const res = await server().inject(edit.request(id));

        expect(res.statusCode).toBe(edit.status ?? 200);
        const pushed = conductor.assets[id] as AlbumAsset | undefined;
        expect(pushed, "the edit never reached the runtime").toBeTruthy();
        edit.pushed(pushed!);
        // The whole asset goes, so the runtime's copy is the workstation's copy — that identity is
        // what makes "is the runtime up to date" answerable by comparing files (ADR 0045).
        expect(pushed).toEqual(store.read(id));
      });

      // Same contract as every other push in this file: the runtime is a side effect, so an
      // unreachable Pi is a syncIssue on the album, never a failed edit. Picking a demo cut in the
      // kitchen with the stand unplugged has to still save the choice.
      it(`still saves ${edit.what} when the runtime is unreachable`, async () => {
        seed(id, edit.given);
        const app = buildServer({
          store,
          roadie: fakeRoadie(store),
          prober: fakeProber(),
          generate: fakeGenerate,
          config: {
            conductor: { url: "http://127.0.0.1:1", pushAssets: true },
          },
        }).app;

        const res = await app.inject(edit.request(id));

        expect(res.statusCode).toBe(edit.status ?? 200);
        edit.pushed(store.read(id)!);
        expect(store.read(id)!.roadie.syncIssues[0]).toMatch(
          /^Conductor: push failed/,
        );
      });
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
