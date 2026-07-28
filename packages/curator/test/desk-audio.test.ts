// Desk audio for bench preview (ADR 0037, issue #93): the album on the producer's own workstation,
// via a Spotify Connect transfer that Curator proxies.
//
// Two properties carry the ADR and get the most attention here:
//
//  1. **A room speaker is never a legal target.** Bench preview promises it touches no hardware
//     (curator-ui-ux §6.1), and Connect works by aiming at a device id — so the "only a local
//     Computer" filter is the whole safety property, not a nicety. The Sonos-in-the-list case is
//     tested directly.
//  2. **Degradation is reported, never fatal** (§10). Not connected, no desktop client, not
//     Premium, no Spotify URI, Spotify down — each is a 200 with a reason the UI shows, because
//     bench preview without audio is exactly what shipped in #92.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { buildAlbumAsset } from "../src/albums/asset.js";
import { DeskAudio } from "../src/spotify/desk-audio.js";
import { fakeRoadie, fakeProber, fakePayload } from "./helpers.js";

const ALBUM_URI = "spotify:album:1C2h7mLntPSeVYciMRTF4a";

/** A device as Spotify lists it. `Computer` is the desk; `Speaker` is the room. */
const device = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "desk-id",
  name: "DESKTOP-1",
  type: "Computer",
  is_active: false,
  is_restricted: false,
  ...over,
});

/**
 * A stand-in Spotify Web API covering just the player surface, recording what Curator sent so the
 * device-id actually used can be asserted (property 1 above).
 */
function stubSpotify(
  opts: {
    devices?: Array<Record<string, unknown>>;
    playStatus?: number;
    playBody?: unknown;
    pauseStatus?: number;
    pauseBody?: unknown;
  } = {},
) {
  const plays: Array<{ deviceId?: string; body: unknown }> = [];
  let pauses = 0;
  const app = Fastify();
  app.get("/v1/me/player/devices", async () => ({
    devices: opts.devices ?? [device()],
  }));
  app.put("/v1/me/player/play", async (req, reply) => {
    plays.push({
      deviceId: (req.query as { device_id?: string }).device_id,
      body: req.body,
    });
    if (opts.playStatus && opts.playStatus >= 400)
      return reply.code(opts.playStatus).send(opts.playBody ?? {});
    return reply.code(204).send();
  });
  app.put("/v1/me/player/pause", async (_req, reply) => {
    pauses += 1;
    if (opts.pauseStatus && opts.pauseStatus >= 400)
      return reply.code(opts.pauseStatus).send(opts.pauseBody ?? {});
    return reply.code(204).send();
  });
  return { app, plays, pauseCount: () => pauses };
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
      spotifyUri: ALBUM_URI,
    },
    artworkPosixPath: `media/artwork/${curatorId}.jpg`,
    contentHash: "sha256:deadbeef",
    palette: fakePayload(),
    now: () => "2026-07-27T00:00:00.000Z",
  });

const manualAlbum = (curatorId: string) =>
  buildAlbumAsset({
    curatorId,
    metadata: { name: "Private Press", artist: "Nobody", source: "manual" },
    artworkPosixPath: `media/artwork/${curatorId}.jpg`,
    contentHash: "sha256:deadbeef",
    palette: fakePayload(),
    now: () => "2026-07-27T00:00:00.000Z",
  });

describe("DeskAudio", () => {
  let stub: ReturnType<typeof stubSpotify>;

  const build = (
    stubOpts: Parameters<typeof stubSpotify>[0] = {},
    over: { token?: string | undefined; timeoutMs?: number } = {},
  ) => {
    stub = stubSpotify(stubOpts);
    return listen(stub.app).then(
      (apiBase) =>
        new DeskAudio({
          getUserToken: async () =>
            "token" in over ? over.token : "user-token",
          apiBase,
          ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
        }),
    );
  };

  afterEach(async () => {
    await stub?.app.close();
  });

  it("transfers to the desktop client and starts the album there", async () => {
    const desk = await build();
    expect(await desk.play(ALBUM_URI)).toEqual({
      played: true,
      device: "DESKTOP-1",
    });
    expect(stub.plays[0]!.deviceId).toBe("desk-id");
    expect(stub.plays[0]!.body).toMatchObject({ context_uri: ALBUM_URI });
  });

  // THE safety property: bench preview must not be able to reach the listening room.
  it("never targets a speaker, even when one is the only active device", async () => {
    const desk = await build({
      devices: [
        device({ id: "sonos-id", name: "Living Room", type: "Speaker" }),
        device({ id: "phone-id", name: "Pixel", type: "Smartphone" }),
      ],
    });
    const result = await desk.play(ALBUM_URI);

    expect(result.played).toBe(false);
    expect(result.reason).toMatch(/No desktop Spotify client/);
    expect(stub.plays).toHaveLength(0); // nothing was asked to play, anywhere
  });

  it("picks the Computer out of a mixed device list", async () => {
    const desk = await build({
      devices: [
        device({ id: "sonos-id", name: "Living Room", type: "Speaker" }),
        device({ id: "desk-id", name: "DESKTOP-1", type: "Computer" }),
      ],
    });
    expect((await desk.play(ALBUM_URI)).played).toBe(true);
    expect(stub.plays[0]!.deviceId).toBe("desk-id");
  });

  // A restricted device is listed but refuses Web API commands — targeting it would 403.
  it("skips a restricted Computer rather than failing against it", async () => {
    const desk = await build({
      devices: [device({ is_restricted: true })],
    });
    expect((await desk.play(ALBUM_URI)).reason).toMatch(
      /No desktop Spotify client/,
    );
    expect(stub.plays).toHaveLength(0);
  });

  it("reports no session as a reason rather than throwing", async () => {
    const desk = await build({}, { token: undefined });
    expect(await desk.play(ALBUM_URI)).toEqual({
      played: false,
      reason: expect.stringMatching(/isn't connected/),
    });
  });

  it("turns a 403 into the Premium requirement, in words", async () => {
    const desk = await build({
      playStatus: 403,
      playBody: { error: { message: "Player command failed" } },
    });
    expect((await desk.play(ALBUM_URI)).reason).toMatch(/Premium/);
  });

  it("turns a 401 into a reconnect instruction", async () => {
    const desk = await build({
      playStatus: 401,
      playBody: { error: { message: "The access token expired" } },
    });
    expect((await desk.play(ALBUM_URI)).reason).toMatch(/reconnect/i);
  });

  it("keeps Spotify's own message for a status it doesn't recognise", async () => {
    const desk = await build({
      playStatus: 502,
      playBody: { error: { message: "Bad gateway" } },
    });
    expect((await desk.play(ALBUM_URI)).reason).toBe(
      "Spotify returned 502 — Bad gateway",
    );
  });

  it("pauses the desk", async () => {
    const desk = await build();
    expect(await desk.pause()).toEqual({ paused: true });
    expect(stub.pauseCount()).toBe(1);
  });

  // Pausing an already-paused player is Spotify's "Restriction violated" — the state we wanted.
  it("treats an already-paused player as paused, not as an error", async () => {
    const desk = await build({
      pauseStatus: 403,
      pauseBody: {
        error: { message: "Player command failed: Restriction violated" },
      },
    });
    expect(await desk.pause()).toEqual({ paused: true });
  });

  it("treats no active device as paused", async () => {
    const desk = await build({ pauseStatus: 404 });
    expect(await desk.pause()).toEqual({ paused: true });
  });

  it("still surfaces a real failure on pause", async () => {
    const desk = await build({
      pauseStatus: 403,
      pauseBody: { error: { message: "Player command failed" } },
    });
    expect(await desk.pause()).toEqual({
      paused: false,
      reason: expect.stringMatching(/Premium/),
    });
  });

  // Curator is always-on: a wedged Spotify must not hold the event loop (CLAUDE.md).
  it("gives up on a hung Spotify instead of hanging the request", async () => {
    const hung = Fastify();
    hung.get("/v1/me/player/devices", () => new Promise(() => {}));
    const apiBase = await listen(hung);
    try {
      const desk = new DeskAudio({
        getUserToken: async () => "user-token",
        apiBase,
        timeoutMs: 50,
      });
      const result = await desk.play(ALBUM_URI);
      expect(result.played).toBe(false);
      expect(result.reason).toMatch(/did not respond within 50ms/);
    } finally {
      await hung.close();
    }
  });

  it("reports an unreachable Spotify as a reason", async () => {
    const desk = new DeskAudio({
      getUserToken: async () => "user-token",
      // A port nothing is listening on: connection refused, not a timeout.
      apiBase: "http://127.0.0.1:1",
    });
    const result = await desk.play(ALBUM_URI);
    expect(result.played).toBe(false);
    expect(result.reason).toMatch(/unreachable/);
  });
});

describe("POST/DELETE /api/albums/:curatorId/desk-audio", () => {
  let stub: ReturnType<typeof stubSpotify>;
  let apiBase: string;
  let store: AssetStore;

  beforeEach(async () => {
    stub = stubSpotify();
    apiBase = await listen(stub.app);
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-desk-")));
  });
  afterEach(async () => {
    await stub.app.close();
  });

  const curator = (withDeskAudio = true) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      ...(withDeskAudio
        ? {
            deskAudio: new DeskAudio({
              getUserToken: async () => "user-token",
              apiBase,
            }),
          }
        : {}),
    }).app;

  it("plays the album's Spotify URI at the desk, and names the device back", async () => {
    store.save(spotifyAlbum("desk0001"));
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/desk0001/desk-audio",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ played: true, device: "DESKTOP-1" });
    expect(stub.plays[0]!.body).toMatchObject({ context_uri: ALBUM_URI });
  });

  it("reports an album with no Spotify URI as a reason, not an error", async () => {
    store.save(manualAlbum("desk0002"));
    const res = await curator().inject({
      method: "POST",
      url: "/api/albums/desk0002/desk-audio",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().played).toBe(false);
    expect(res.json().reason).toMatch(/no Spotify URI/);
    expect(stub.plays).toHaveLength(0);
  });

  it("reports Spotify-unconfigured as a reason, not an error", async () => {
    store.save(spotifyAlbum("desk0003"));
    const res = await curator(false).inject({
      method: "POST",
      url: "/api/albums/desk0003/desk-audio",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().played).toBe(false);
    expect(res.json().reason).toMatch(/isn't set up/);
  });

  it("pauses on DELETE", async () => {
    store.save(spotifyAlbum("desk0004"));
    const res = await curator().inject({
      method: "DELETE",
      url: "/api/albums/desk0004/desk-audio",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paused: true });
    expect(stub.pauseCount()).toBe(1);
  });

  it("404s for an unknown album on both verbs", async () => {
    const app = curator();
    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/api/albums/missing0/desk-audio",
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
