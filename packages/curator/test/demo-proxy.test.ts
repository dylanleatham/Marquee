import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { buildFreshAsset } from "../src/albums/asset.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

// A stand-in Conductor: records what Curator forwards and returns canned playback responses, so the
// proxy is tested against a real HTTP hop (real fetch, real status codes) without a Hue bridge.
function stubConductor() {
  const received: Array<{ path: string; body: unknown }> = [];
  const app = Fastify();
  app.post("/api/playback", async (req) => {
    received.push({ path: "/api/playback", body: req.body });
    return { playbackId: "pb-1" };
  });
  app.post("/api/playback/stop", async (req) => {
    received.push({ path: "/api/playback/stop", body: req.body });
    return { stopped: true, roomId: "1" };
  });
  app.get("/api/rooms", async () => ({
    rooms: [{ id: "1", name: "Living", type: "Room", lightIds: ["11"] }],
  }));
  app.get("/api/bridge/status", async () => ({
    paired: true,
    reachable: true,
  }));
  app.get("/api/settings", async () => ({ listeningRoomId: "1" }));
  app.put("/api/settings", async (req) => {
    received.push({ path: "/api/settings", body: req.body });
    return {
      listeningRoomId: (req.body as { listeningRoomId?: string })
        .listeningRoomId,
    };
  });
  return { app, received };
}

describe("Demo Room proxy → Conductor", () => {
  let conductor: ReturnType<typeof stubConductor>;
  let url: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubConductor();
    await conductor.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = conductor.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-demo-")));
  });
  afterEach(async () => {
    await conductor.app.close();
  });

  const curator = (conductorUrl = url) => {
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { conductor: { url: conductorUrl } },
    });
    return app;
  };

  it("play forwards the album's palette payload and returns Conductor's response", async () => {
    store.save(makeAsset("abc12345", "Purple Rain", "Prince"));
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ playbackId: "pb-1" });

    const sent = conductor.received.find((r) => r.path === "/api/playback");
    expect(sent).toBeTruthy();
    const palette = (sent!.body as { palette: { pattern: { type: string } } })
      .palette;
    expect(palette.pattern.type).toBe("crossfade"); // built from the album's stored pattern
  });

  it("play 404s for an unknown album", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "missing00" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("play 409s when the album has no palette yet", async () => {
    store.save(
      buildFreshAsset({
        curatorId: "unready1",
        metadata: { name: "X", artist: "Y", source: "manual" },
        now: () => "2026-07-11T00:00:00.000Z",
      }),
    );
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "unready1" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("stop forwards to Conductor", async () => {
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true });
  });

  it("rooms proxies Conductor's room list", async () => {
    const res = await curator().inject({
      method: "GET",
      url: "/api/demo/rooms",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rooms[0].name).toBe("Living");
  });

  it("room PUT forwards the chosen listening room", async () => {
    const res = await curator().inject({
      method: "PUT",
      url: "/api/demo/room",
      payload: { roomId: "1" },
    });
    expect(res.statusCode).toBe(200);
    const sent = conductor.received.find((r) => r.path === "/api/settings");
    expect(sent!.body).toMatchObject({ listeningRoomId: "1" });
  });

  it("status aggregates reachable + paired + listening room", async () => {
    const res = await curator().inject({
      method: "GET",
      url: "/api/demo/status",
    });
    expect(res.json()).toEqual({
      reachable: true,
      paired: true,
      listeningRoomId: "1",
    });
  });

  it("reports Conductor being down as a 502 on play and reachable:false on status", async () => {
    const dead = "http://127.0.0.1:1"; // nothing listening → ECONNREFUSED
    store.save(makeAsset("abc12345"));

    const play = await curator(dead).inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });
    expect(play.statusCode).toBe(502);

    const status = await curator(dead).inject({
      method: "GET",
      url: "/api/demo/status",
    });
    expect(status.json()).toEqual({
      reachable: false,
      paired: false,
      listeningRoomId: null,
    });
  });
});
