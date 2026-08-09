import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
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

/**
 * A stand-in Backdrop speaking the one endpoint the Demo Room needs. `202 {accepted:true}` with no
 * `action` is Backdrop's real success shape — it accepts a scan and signals the kiosk (issue #277).
 */
function stubBackdrop() {
  const received: Array<{ event: string; uri?: string }> = [];
  const app = Fastify();
  app.post("/api/scan", async (req) => {
    received.push(req.body as { event: string; uri?: string });
    return { accepted: true };
  });
  return { app, received };
}

describe("Demo Room proxy → Conductor", () => {
  let conductor: ReturnType<typeof stubConductor>;
  let backdrop: ReturnType<typeof stubBackdrop>;
  let backdropUrl: string;
  let url: string;
  let store: AssetStore;

  beforeEach(async () => {
    conductor = stubConductor();
    await conductor.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = conductor.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    backdrop = stubBackdrop();
    await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
    backdropUrl = `http://127.0.0.1:${(backdrop.app.server.address() as AddressInfo).port}`;
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-demo-")));
  });
  afterEach(async () => {
    await conductor.app.close();
    await backdrop.app.close();
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

  /** The Demo Room as the spec describes it: a room with a screen in it as well as lights. */
  const curatorWithScreen = (bdUrl = backdropUrl) => {
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: {
        conductor: { url },
        backdrop: {
          url: bdUrl,
          mediaDir: join(tmpdir(), "bd"),
          syncMediaLocally: false,
        },
      },
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
    // The screen's result rides alongside the lights' rather than replacing it (issue #277). This
    // fixture configures no Backdrop, so it reports that plainly instead of going quiet.
    expect(res.json()).toEqual({
      playbackId: "pb-1",
      video: { ok: false, reason: "not configured" },
    });

    const sent = conductor.received.find((r) => r.path === "/api/playback");
    expect(sent).toBeTruthy();
    const palette = (sent!.body as { palette: { pattern: { type: string } } })
      .palette;
    expect(palette.pattern.type).toBe("crossfade"); // built from the album's stored pattern
  });

  // Issue #277. curator-ui-ux §6.2 calls the Demo Room "the full-viewport presentation" of the room
  // rehearsal — lights *and* video — but every /api/demo/* route talked to Conductor alone, so
  // placing a record lit the room and left the screen black. Backdrop resolves video by URI from its
  // own library and has nothing live to edit, so a scan event is the right shape for it; Conductor
  // keeps receiving the live-edited palette, which is what makes pattern tuning work.
  it("play drives the screen as well as the lights", async () => {
    store.save(makeAsset("abc12345", "Purple Rain", "Prince"));
    const res = await curatorWithScreen().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      playbackId: "pb-1",
      video: { ok: true },
    });
    expect(backdrop.received).toEqual([
      {
        event: "start",
        uri: "curator:album:abc12345",
        tagUid: expect.any(String),
        readerId: expect.any(String),
        at: expect.any(String),
      },
    ]);
    // The lights still get the live payload, not a scan — that is what pattern tuning re-applies.
    const lights = conductor.received.find((r) => r.path === "/api/playback");
    expect((lights!.body as { palette: unknown }).palette).toBeTruthy();
  });

  // The Room screen re-applies the lights on *every* pattern change. If that restarted the
  // visualizer each time, tuning a pattern would be unusable — so the lights have to be drivable
  // without touching the screen. Caught in review: the first cut of #277 fanned out unconditionally
  // while the comments and spec claimed this exemption existed.
  it("re-applies the lights alone when the caller opts out of the screen", async () => {
    store.save(makeAsset("abc12345"));
    const res = await curatorWithScreen().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345", video: false },
    });

    expect(res.statusCode).toBe(200);
    expect(conductor.received.some((r) => r.path === "/api/playback")).toBe(
      true,
    );
    expect(backdrop.received).toEqual([]);
    // Absent, not `false`: "we did not ask" is not "the screen failed".
    expect(res.json().video).toBeUndefined();
  });

  it("lifting the sleeve stops the screen too", async () => {
    const res = await curatorWithScreen().inject({
      method: "POST",
      url: "/api/demo/stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: true, video: { ok: true } });
    expect(backdrop.received.at(-1)).toMatchObject({ event: "stop" });
  });

  // runtime-overview §8: one dead service degrades the room, it does not fail it. A dark screen must
  // not cost you the lights as well — and the reason has to reach the operator, or a black screen is
  // indistinguishable from a record with no visualizer.
  it("keeps the lights when the screen is unreachable, and says why", async () => {
    store.save(makeAsset("abc12345"));
    const res = await curatorWithScreen("http://127.0.0.1:1").inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });

    expect(res.statusCode).toBe(200); // the lights ran
    expect(res.json().playbackId).toBe("pb-1");
    expect(res.json().video.ok).toBe(false);
    expect(res.json().video.reason).toBeTruthy();
  });

  it("says the screen is not set up rather than pretending it failed", async () => {
    store.save(makeAsset("abc12345"));
    // No Backdrop in the config at all — a workstation with no runtime, which is the common case.
    const res = await curator().inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().video).toEqual({ ok: false, reason: "not configured" });
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
    // Port 1 is on fetch's blocked-ports list, so the request is rejected before it reaches the
    // network. Either way the proxy sees a rejection, which is what this exercises.
    const dead = "http://127.0.0.1:1";
    store.save(makeAsset("abc12345"));

    const play = await curator(dead).inject({
      method: "POST",
      url: "/api/demo/play",
      payload: { curatorId: "abc12345" },
    });
    expect(play.statusCode).toBe(502);
    // Issue #270: the body names the service and the address, and stops. It used to append "is it
    // running?" — a guess that survived three unrelated faults on 2026-08-08, sending debugging to
    // a service that was healthy every time.
    expect(play.json().error).toMatch(/^Hue Conductor: /);
    expect(play.json().error).toContain(dead);
    expect(play.json().error).not.toMatch(/is it running/i);

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
