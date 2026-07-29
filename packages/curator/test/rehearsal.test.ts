// Room rehearsal (ADR 0028): the real runtime path minus the physical tag — a scan event fanned out
// to Conductor and Backdrop exactly as Stylus would send it, plus Amp driven through its documented
// admin override for the audio leg. Every leg is best-effort and independently reported, so one dead
// service degrades the rehearsal rather than failing it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { buildAlbumAsset } from "../src/albums/asset.js";
import { AmpClient, AmpError } from "../src/amp/client.js";
import { fakeRoadie, fakeProber, fakePayload } from "./helpers.js";

type Leg = { service: string; ok: boolean; reason?: string };

/** A stand-in runtime service exposing /api/scan, recording what Curator fans out. */
function stubScanService() {
  const received: Array<{ body: unknown; secret?: string }> = [];
  const app = Fastify();
  app.post("/api/scan", async (req) => {
    received.push({
      body: req.body,
      secret: req.headers["x-trigger-secret"] as string | undefined,
    });
    return { accepted: true };
  });
  return { app, received };
}

/**
 * A stand-in service that accepts a scan and then explicitly does nothing with it — Conductor's
 * documented degrade shape (ADR 0019 / hue-conductor-spec): a 2xx whose body says the scan was
 * ignored and why. `no listening room`, `album not synced` and `album not ready` all take this form.
 */
function stubIgnoringScanService(reason: string) {
  const received: Array<{ body: unknown }> = [];
  const app = Fastify();
  app.post("/api/scan", async (req, reply) => {
    received.push({ body: req.body });
    return reply.code(202).send({ ok: true, action: "ignored", reason });
  });
  return { app, received };
}

/** A stand-in Amp exposing the admin override rows from amp-spec. */
function stubAmp() {
  const played: Array<{ spotifyUri?: string }> = [];
  let stops = 0;
  const app = Fastify();
  app.post("/api/admin/play", async (req) => {
    played.push(req.body as { spotifyUri?: string });
    return { ok: true };
  });
  app.post("/api/admin/stop", async () => {
    stops += 1;
    return { ok: true };
  });
  app.get("/api/status", async () => ({ state: "playing", target: "Kitchen" }));
  return { app, played, stopCount: () => stops };
}

const listen = async (app: ReturnType<typeof Fastify>) => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

const spotifyAlbum = (curatorId: string) =>
  buildAlbumAsset({
    curatorId,
    metadata: {
      name: "Purple Rain",
      artist: "Prince",
      source: "spotify",
      spotifyUri: "spotify:album:1C2h7mLntPSeVYciMRTF4a",
    },
    artworkPosixPath: `media/artwork/${curatorId}.jpg`,
    contentHash: "sha256:deadbeef",
    palette: fakePayload(),
    now: () => "2026-07-25T00:00:00.000Z",
  });

describe("AmpClient", () => {
  let amp: ReturnType<typeof stubAmp>;
  let url: string;

  beforeEach(async () => {
    amp = stubAmp();
    url = await listen(amp.app);
  });
  afterEach(async () => {
    await amp.app.close();
  });

  it("plays an album and sends the shared secret", async () => {
    const seen: Array<Record<string, string>> = [];
    const client = new AmpClient({
      url,
      sharedSecret: "s3cret",
      fetchImpl: (input, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return fetch(input, init);
      },
    });

    await client.play("spotify:album:xyz", "Kitchen");

    expect(amp.played).toEqual([
      { spotifyUri: "spotify:album:xyz", targetRoom: "Kitchen" },
    ]);
    expect(seen[0]!["x-trigger-secret"]).toBe("s3cret");
  });

  it("omits targetRoom when not given, so Amp uses its configured default", async () => {
    await new AmpClient({ url }).play("spotify:album:xyz");
    expect(amp.played).toEqual([{ spotifyUri: "spotify:album:xyz" }]);
  });

  it("stops playback", async () => {
    await new AmpClient({ url }).stop();
    expect(amp.stopCount()).toBe(1);
  });

  it("reads status", async () => {
    expect(await new AmpClient({ url }).status()).toMatchObject({
      state: "playing",
    });
  });

  it("throws AmpError carrying the status on a non-2xx", async () => {
    const failing = Fastify();
    failing.post("/api/admin/play", async (_req, reply) =>
      reply.code(503).send({ error: "no sonos" }),
    );
    const failUrl = await listen(failing);
    try {
      await expect(
        new AmpClient({ url: failUrl }).play("spotify:album:xyz"),
      ).rejects.toBeInstanceOf(AmpError);
    } finally {
      await failing.close();
    }
  });

  // Curator is an always-on service: an unbounded call to a wedged Amp would hold the event loop.
  it("aborts a hung Amp rather than hanging the caller", async () => {
    const hung = Fastify();
    hung.post("/api/admin/play", () => new Promise(() => {}));
    const hungUrl = await listen(hung);
    try {
      await expect(
        new AmpClient({ url: hungUrl, timeoutMs: 50 }).play("spotify:album:x"),
      ).rejects.toThrow();
    } finally {
      await hung.close();
    }
  });
});

describe("POST /api/demo/audio", () => {
  let amp: ReturnType<typeof stubAmp>;
  let ampUrl: string;
  let store: AssetStore;

  beforeEach(async () => {
    amp = stubAmp();
    ampUrl = await listen(amp.app);
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-rehearse-")));
  });
  afterEach(async () => {
    await amp.app.close();
  });

  const curator = (withAmp = true) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      ...(withAmp ? { amp: new AmpClient({ url: ampUrl }) } : {}),
    }).app;

  it("proxies the album's Spotify URI to Amp so the browser never holds the secret", async () => {
    store.save(spotifyAlbum("audio001"));
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/audio",
      payload: { curatorId: "audio001" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ played: true });
    expect(amp.played[0]).toMatchObject({
      spotifyUri: "spotify:album:1C2h7mLntPSeVYciMRTF4a",
    });
  });

  it("reports Amp-unconfigured as a reason, not an error", async () => {
    store.save(spotifyAlbum("audio002"));
    const res = await curator(false).inject({
      method: "POST",
      url: "/api/demo/audio",
      payload: { curatorId: "audio002" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().played).toBe(false);
    expect(res.json().reason).toMatch(/isn't configured/);
  });

  it("reports an album with no Spotify URI as a reason, not an error", async () => {
    store.save(
      buildAlbumAsset({
        curatorId: "audio003",
        metadata: { name: "Private Press", artist: "Nobody", source: "manual" },
        artworkPosixPath: "media/artwork/audio003.jpg",
        contentHash: "sha256:deadbeef",
        palette: fakePayload(),
        now: () => "2026-07-25T00:00:00.000Z",
      }),
    );
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/audio",
      payload: { curatorId: "audio003" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().played).toBe(false);
    expect(res.json().reason).toMatch(/no Spotify URI/);
  });

  it("404s for an unknown album and 400s with no curatorId", async () => {
    const app = curator();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo/audio",
          payload: { curatorId: "missing0" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo/audio",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("POST /api/albums/:curatorId/simulate-scan", () => {
  let conductor: ReturnType<typeof stubScanService>;
  let backdrop: ReturnType<typeof stubScanService>;
  let amp: ReturnType<typeof stubAmp>;
  let conductorUrl: string;
  let backdropUrl: string;
  let ampUrl: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubScanService();
    backdrop = stubScanService();
    amp = stubAmp();
    conductorUrl = await listen(conductor.app);
    backdropUrl = await listen(backdrop.app);
    ampUrl = await listen(amp.app);
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-scan-")));
    store.save(spotifyAlbum("scan0001"));
  });
  afterEach(async () => {
    await Promise.all([
      conductor.app.close(),
      backdrop.app.close(),
      amp.app.close(),
    ]);
  });

  const curator = (over: { backdrop?: boolean; amp?: boolean } = {}) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: {
        conductor: { url: conductorUrl, sharedSecret: "s3cret" },
        ...(over.backdrop === false
          ? {}
          : {
              backdrop: {
                url: backdropUrl,
                sharedSecret: "s3cret",
                mediaDir: join(tmpdir(), "bd-media"),
                syncMediaLocally: false,
              },
            }),
      },
      ...(over.amp === false ? {} : { amp: new AmpClient({ url: ampUrl }) }),
    }).app;

  const legs = (body: string): Leg[] => JSON.parse(body).services;

  it("fans a start event out to Conductor, Backdrop and Amp", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0001/simulate-scan",
    });

    expect(res.statusCode).toBe(200);
    expect(legs(res.body)).toEqual([
      { service: "conductor", ok: true },
      { service: "backdrop", ok: true },
      { service: "amp", ok: true },
    ]);

    // Conductor and Backdrop get the runtime scan shape, with the sleeve URI.
    for (const svc of [conductor, backdrop]) {
      expect(svc.received[0]!.body).toMatchObject({
        event: "start",
        uri: "curator:album:scan0001",
        readerId: "curator-rehearsal",
      });
      expect(svc.received[0]!.secret).toBe("s3cret");
    }
    expect(amp.played[0]).toMatchObject({
      spotifyUri: "spotify:album:1C2h7mLntPSeVYciMRTF4a",
    });
  });

  it("skips the audio leg when audio is opted out", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0001/simulate-scan",
      payload: { audio: false },
    });

    expect(legs(res.body)).toContainEqual({
      service: "amp",
      ok: false,
      reason: "audio opted out",
    });
    expect(amp.played).toHaveLength(0);
    // Lights and video still ran — opting out of audio is not opting out of the rehearsal.
    expect(conductor.received).toHaveLength(1);
    expect(backdrop.received).toHaveLength(1);
  });

  it("degrades rather than fails when Backdrop and Amp are unconfigured", async () => {
    const res = await curator({ backdrop: false, amp: false }).inject({
      method: "POST",
      url: "/api/albums/scan0001/simulate-scan",
    });

    expect(res.statusCode).toBe(200);
    const result = legs(res.body);
    expect(result.find((l) => l.service === "conductor")!.ok).toBe(true);
    expect(result.find((l) => l.service === "backdrop")).toEqual({
      service: "backdrop",
      ok: false,
      reason: "not configured",
    });
    expect(result.find((l) => l.service === "amp")!.ok).toBe(false);
  });

  it("reports a dead service on its own leg without failing the others", async () => {
    await backdrop.app.close(); // Backdrop is configured but down
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0001/simulate-scan",
    });

    expect(res.statusCode).toBe(200);
    const result = legs(res.body);
    expect(result.find((l) => l.service === "backdrop")!.ok).toBe(false);
    expect(result.find((l) => l.service === "conductor")!.ok).toBe(true);
    expect(result.find((l) => l.service === "amp")!.ok).toBe(true);
  });

  it("404s for an unknown album", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/missing0/simulate-scan",
    });
    expect(res.statusCode).toBe(404);
  });

  it("stop fans a stop event out and stops Amp", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0001/simulate-scan/stop",
    });

    expect(res.statusCode).toBe(200);
    expect(legs(res.body).every((l) => l.ok)).toBe(true);
    expect(conductor.received[0]!.body).toMatchObject({ event: "stop" });
    expect(conductor.received[0]!.body).not.toHaveProperty("uri");
    expect(amp.stopCount()).toBe(1);
  });
});

/**
 * A service can accept a scan (2xx) and still deliberately do nothing with it — Conductor answers
 * `202 {ok:true, action:"ignored", reason}` for a scan it can't act on. Reporting that as a
 * successful leg is what let issue #164 hide: Preview said "Lights running" while the room stayed
 * dark, so every diagnosis started from a false premise.
 *
 * A leg that was ignored did not run. That is exactly what `leg()`'s `skip` already expresses for
 * the reasons Curator knows up front; these are the same class of outcome, decided by the service.
 */
describe("a scan a service accepted but ignored", () => {
  let conductor: ReturnType<typeof stubIgnoringScanService>;
  let conductorUrl: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubIgnoringScanService("album not synced");
    conductorUrl = await listen(conductor.app);
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-ignored-")));
    store.save(spotifyAlbum("scan0002"));
  });
  afterEach(async () => {
    await conductor.app.close();
  });

  const curator = () =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { conductor: { url: conductorUrl } },
    }).app;

  const legs = (body: string): Leg[] => JSON.parse(body).services;
  const conductorLeg = (body: string) =>
    legs(body).find((l) => l.service === "conductor")!;

  it("reports the leg as not ok, carrying the service's own reason", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0002/simulate-scan",
      payload: { audio: false },
    });

    expect(res.statusCode).toBe(200);
    // The request genuinely reached Conductor — this is not a transport failure.
    expect(conductor.received).toHaveLength(1);
    expect(conductorLeg(res.body)).toEqual({
      service: "conductor",
      ok: false,
      reason: "album not synced",
    });
  });

  it("reports an ignored stop the same way, so a stuck room is visible", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/scan0002/simulate-scan/stop",
    });

    expect(res.statusCode).toBe(200);
    expect(conductorLeg(res.body).ok).toBe(false);
    expect(conductorLeg(res.body).reason).toBe("album not synced");
  });

  // The whole family, not just the one that bit us (bug-fix workflow: widen to the bug's family).
  it.each(["no listening room", "album not synced", "album not ready"])(
    "treats %s as a leg that did not run",
    async (reason) => {
      const svc = stubIgnoringScanService(reason);
      const url = await listen(svc.app);
      try {
        const res = await buildServer({
          store,
          roadie: fakeRoadie(store),
          prober: fakeProber(),
          config: { conductor: { url } },
        }).app.inject({
          method: "POST",
          url: "/api/albums/scan0002/simulate-scan",
          payload: { audio: false },
        });
        expect(conductorLeg(res.body)).toEqual({
          service: "conductor",
          ok: false,
          reason,
        });
      } finally {
        await svc.app.close();
      }
    },
  );

  // Backdrop answers `202 {accepted:true}` — an accepted scan with no `action` is still a success.
  it("still reports a plain 202 acceptance as ok", async () => {
    const accepting = Fastify();
    accepting.post("/api/scan", async (_req, reply) =>
      reply.code(202).send({ accepted: true }),
    );
    const url = await listen(accepting);
    try {
      const res = await buildServer({
        store,
        roadie: fakeRoadie(store),
        prober: fakeProber(),
        config: { conductor: { url } },
      }).app.inject({
        method: "POST",
        url: "/api/albums/scan0002/simulate-scan",
        payload: { audio: false },
      });
      expect(conductorLeg(res.body)).toEqual({
        service: "conductor",
        ok: true,
      });
    } finally {
      await accepting.close();
    }
  });
});
