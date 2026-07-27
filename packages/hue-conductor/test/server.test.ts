import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { buildServer } from "../src/server.js";
import { makeFakeDriver, FakeTimers } from "./fakes.js";

const SECRET = "test-secret";
const AUTH = { "x-trigger-secret": SECRET };

// A minimal static palette payload for the playback endpoints.
const PALETTE = {
  version: 1,
  source: { type: "album" },
  palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
  pattern: { type: "static", params: {} },
};

const seededStore = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), "conductor-srv-")));
  s.saveBridge({
    id: "BID",
    ip: "10.0.0.5",
    applicationKey: "k",
    pairedAt: "t",
  });
  return s;
};
const livingRoom = () =>
  makeFakeDriver({
    groups: [{ id: "1", name: "Living", type: "Room", lights: ["11", "12"] }],
  });

describe("hue-conductor HTTP API", () => {
  it("/healthz needs no auth and reports paired state", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, paired: true });
  });

  it("rejects /api/* without the shared secret", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(401);
  });

  it("returns rooms when the shared secret is present", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rooms[0].name).toBe("Living");
  });

  it("POST /api/test/color sets every light in the room", async () => {
    const fake = livingRoom();
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: fake.driver,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/test/color",
      headers: AUTH,
      payload: { roomId: "1", hex: "#4B0082" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lightsSet: 2 });
    expect(fake.setCalls).toHaveLength(2);
  });

  it("POST /api/test/color 400s without roomId/hex", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/test/color",
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s when no bridge is paired", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "conductor-np-")));
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store,
      driver: makeFakeDriver().driver,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /api/settings returns current settings and PUT persists listeningRoomId", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });

    let res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listeningRoomId).toBeNull();

    res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: AUTH,
      payload: { listeningRoomId: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listeningRoomId).toBe("1");

    res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: AUTH,
    });
    expect(res.json().listeningRoomId).toBe("1"); // persisted
  });

  describe("GET /api/bridge/status", () => {
    it("reports unpaired when no bridge is stored", async () => {
      const store = new Store(mkdtempSync(join(tmpdir(), "conductor-st-")));
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: makeFakeDriver().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toEqual({ paired: false });
    });

    it("reports paired + reachable when the bridge answers", async () => {
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: makeFakeDriver().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toMatchObject({ paired: true, reachable: true });
    });

    it("reports paired + unreachable when the bridge errors", async () => {
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: makeFakeDriver({ configThrows: true }).driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toMatchObject({ paired: true, reachable: false });
    });
  });

  describe("playback (conductor-spec §9)", () => {
    const build = (store: Store, driver: ReturnType<typeof livingRoom>) =>
      buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: driver.driver,
        timers: new FakeTimers(), // no real 90-min idle interval leaks out of the test
      });

    it("POST /api/playback starts a session and drives the room's lights", async () => {
      const fake = livingRoom();
      const { app } = build(seededStore(), fake);
      const res = await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: { roomId: "1", palette: PALETTE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().playbackId).toBeTruthy();
      expect(fake.setCalls).toHaveLength(2); // both lights in Living
    });

    it("POST /api/playback falls back to the configured listening room", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake);
      const res = await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: { palette: PALETTE }, // no roomId
      });
      expect(res.statusCode).toBe(200);
      expect(fake.setCalls.length).toBeGreaterThan(0);
    });

    it("POST /api/playback 400s when no room is given or configured", async () => {
      const { app } = build(seededStore(), livingRoom());
      const res = await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: { palette: PALETTE },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/playback 400s on a palette with no colors", async () => {
      const { app } = build(seededStore(), livingRoom());
      const res = await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: {
          roomId: "1",
          palette: { ...PALETTE, palette: { colors: [] } },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/playback/stop stops the session and restores the room", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake);
      await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: { palette: PALETTE },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/playback/stop",
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ stopped: true, roomId: "1" });
    });
  });

  describe("scan intake (issue #45)", () => {
    const URI = "curator:album:2k7bxq9m";
    const ALBUM = {
      metadata: { name: "Purple Rain", artist: "Prince", year: 1984 },
      palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
      pattern: { type: "static", params: {} },
    };
    // An in-memory asset reader seeded with whatever albums a test needs.
    const reader = (albums: Record<string, unknown> = {}) => ({
      read: async (id: string) => (albums[id] ?? null) as never,
    });
    const build = (
      store: Store,
      driver: ReturnType<typeof livingRoom>,
      albums?: Record<string, unknown>,
    ) =>
      buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: driver.driver,
        timers: new FakeTimers(),
        assets: reader(albums),
      });
    const scanStart = { event: "start", uri: URI, tagUid: "04:A1", at: "t" };

    it("start drives the listening room from the synced album", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake, { "2k7bxq9m": ALBUM });
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ action: "playing", roomId: "1" });
      expect(fake.setCalls).toHaveLength(2); // both lights in Living
    });

    it("stop restores the room after a start", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake, { "2k7bxq9m": ALBUM });
      await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: { event: "stop", at: "t" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ action: "stopped", roomId: "1" });
    });

    it("degrades gracefully with no listening room configured", async () => {
      const fake = livingRoom();
      const { app } = build(seededStore(), fake, { "2k7bxq9m": ALBUM });
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ action: "ignored" });
      expect(fake.setCalls).toHaveLength(0); // lights untouched
    });

    it("degrades gracefully when the album isn't synced yet", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake, {}); // nothing seeded
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        action: "ignored",
        reason: "album not synced",
      });
      expect(fake.setCalls).toHaveLength(0);
    });

    it("degrades gracefully when the album has no palette yet", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const fake = livingRoom();
      const { app } = build(store, fake, {
        "2k7bxq9m": { metadata: { name: "X", artist: "Y" } }, // no palette/pattern
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        action: "ignored",
        reason: "album not ready",
      });
    });

    it("400s a non-curator album URI", async () => {
      const store = seededStore();
      store.setListeningRoom("1");
      const { app } = build(store, livingRoom(), {});
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: {
          event: "start",
          uri: "spotify:album:abc",
          tagUid: "x",
          at: "t",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s a bad album URI even when no listening room is configured", async () => {
      // URI validation runs before the no-room graceful path (ADR 0019): a malformed URI is always
      // a 400, never silently degraded.
      const { app } = build(seededStore(), livingRoom(), {}); // no listening room set
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: {
          event: "start",
          uri: "spotify:album:abc",
          tagUid: "x",
          at: "t",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s a malformed scan body", async () => {
      const { app } = build(seededStore(), livingRoom(), {});
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: { nonsense: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it("requires the shared secret", async () => {
      const { app } = build(seededStore(), livingRoom(), {});
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        payload: scanStart,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("streaming effects (ADR 0024)", () => {
    const AREA_ID = "12345678-1234-1234-1234-1234567890ab";
    const STREAM_ALBUM = {
      metadata: { name: "Vivid", artist: "X", year: 2020 },
      palette: {
        colors: [
          { hex: "#7867A0", role: "primary" },
          { hex: "#D98D40", role: "accent" },
        ],
      },
      pattern: { type: "aurora", params: {} },
    };
    const scanStart = {
      event: "start",
      uri: "curator:album:2k7bxq9m",
      tagUid: "x",
      at: "t",
    };
    const fakeStream = () => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isStreaming: vi.fn(() => false),
    });
    const build = (
      streamSession: ReturnType<typeof fakeStream>,
      { area }: { area: boolean },
    ) => {
      const store = seededStore();
      store.setListeningRoom("1");
      if (area) store.setEntertainmentArea(AREA_ID);
      const fake = livingRoom();
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: fake.driver,
        timers: new FakeTimers(),
        assets: { read: async () => STREAM_ALBUM as never },
        streamSession,
      });
      return { app, fake };
    };
    const scan = (app: ReturnType<typeof buildServer>["app"]) =>
      app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: scanStart,
      });

    it("routes a streaming effect to the stream session when an area is configured", async () => {
      const ss = fakeStream();
      const { app } = build(ss, { area: true });
      const res = await scan(app);
      expect(res.json()).toMatchObject({
        action: "streaming",
        effect: "aurora",
        areaId: AREA_ID,
      });
      expect(ss.start).toHaveBeenCalledWith(
        "1",
        AREA_ID,
        "aurora",
        ["#7867A0", "#D98D40"],
        {},
      );
    });

    // ADR 0035: an album can opt into an effect while keeping its derived pattern as the fallback.
    // The direct form above cannot express that — the effect *is* the pattern, so there is nothing
    // to fall back to but a guess.
    describe("per-album opt-in (ADR 0035)", () => {
      const OPTED_IN = {
        ...STREAM_ALBUM,
        // Derived, energy-aware, and deliberately NOT a streaming type.
        pattern: {
          type: "crossfade",
          params: { transitionMs: 8000, holdMs: 30000 },
        },
        streamingEffect: "shimmer",
      };
      const buildOptIn = (
        streamSession: ReturnType<typeof fakeStream>,
        { area }: { area: boolean },
      ) => {
        const store = seededStore();
        store.setListeningRoom("1");
        if (area) store.setEntertainmentArea(AREA_ID);
        const fake = livingRoom();
        const { app } = buildServer({
          config: { sharedSecret: SECRET },
          store,
          driver: fake.driver,
          timers: new FakeTimers(),
          assets: { read: async () => OPTED_IN as never },
          streamSession,
        });
        return { app, fake };
      };

      it("plays the opted-in effect when an area is configured", async () => {
        const ss = fakeStream();
        const { app } = buildOptIn(ss, { area: true });
        expect((await scan(app)).json()).toMatchObject({
          action: "streaming",
          effect: "shimmer",
        });
        // No params forwarded: the derived pattern's `transitionMs`/`holdMs` belong to crossfade,
        // and handing them to shimmer would be nonsense.
        expect(ss.start).toHaveBeenCalledWith(
          "1",
          AREA_ID,
          "shimmer",
          ["#7867A0", "#D98D40"],
          {},
        );
      });

      it("falls back to the album's own derived pattern, not a generic rotate", async () => {
        // The reason the opt-in rides beside `pattern` instead of overwriting it. A CLIP-only room
        // must keep the energy-aware motion ADR 0033 derived for this album.
        const ss = fakeStream();
        const { app } = buildOptIn(ss, { area: false });
        expect((await scan(app)).json()).toMatchObject({ action: "playing" });
        expect(ss.start).not.toHaveBeenCalled();

        const { playback } = (
          await app.inject({
            method: "GET",
            url: "/api/playback/current",
            headers: AUTH,
          })
        ).json();
        expect(playback[0].pattern).toBe("crossfade");
      });

      it("falls back to the derived pattern when the session throws, too", async () => {
        const ss = fakeStream();
        ss.start.mockRejectedValueOnce(new Error("handshake timeout"));
        const { app } = buildOptIn(ss, { area: true });
        expect((await scan(app)).json()).toMatchObject({ action: "playing" });

        const { playback } = (
          await app.inject({
            method: "GET",
            url: "/api/playback/current",
            headers: AUTH,
          })
        ).json();
        expect(playback[0].pattern).toBe("crossfade");
      });
    });

    it("falls back to a lively CLIP pattern when no area is configured", async () => {
      const ss = fakeStream();
      const { app, fake } = build(ss, { area: false });
      const res = await scan(app);
      expect(res.json()).toMatchObject({ action: "playing" });
      expect(ss.start).not.toHaveBeenCalled();
      expect(fake.setCalls.length).toBeGreaterThan(0); // CLIP still lit the room
    });

    it("falls back to CLIP when the stream session throws (e.g. handshake fails)", async () => {
      const ss = fakeStream();
      ss.start.mockRejectedValueOnce(new Error("handshake timeout"));
      const { app, fake } = build(ss, { area: true });
      const res = await scan(app);
      expect(res.json()).toMatchObject({ action: "playing" });
      expect(fake.setCalls.length).toBeGreaterThan(0);
    });

    it("a stop scan halts an active stream session", async () => {
      const ss = fakeStream();
      ss.isStreaming.mockReturnValue(true);
      const { app } = build(ss, { area: true });
      await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: { event: "stop", at: "t" },
      });
      expect(ss.stop).toHaveBeenCalled();
    });

    it("/api/playback/stop halts an active stream session (not just CLIP)", async () => {
      const ss = fakeStream();
      ss.isStreaming.mockReturnValue(true);
      const { app } = build(ss, { area: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/playback/stop",
        headers: AUTH,
        payload: { roomId: "1" },
      });
      expect(res.json()).toMatchObject({ stopped: true });
      expect(ss.stop).toHaveBeenCalled();
    });

    it("routes a streaming effect submitted to /api/playback (Demo Room / manual curl)", async () => {
      const ss = fakeStream();
      const { app } = build(ss, { area: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/playback",
        headers: AUTH,
        payload: {
          roomId: "1",
          palette: {
            version: 1,
            source: { type: "album" },
            palette: {
              colors: [
                { hex: "#7867A0", role: "primary" },
                { hex: "#D98D40", role: "accent" },
              ],
            },
            pattern: { type: "aurora", params: {} },
          },
        },
      });
      expect(res.json()).toMatchObject({
        streaming: true,
        effect: "aurora",
        areaId: AREA_ID,
      });
      expect(ss.start).toHaveBeenCalledWith(
        "1",
        AREA_ID,
        "aurora",
        ["#7867A0", "#D98D40"],
        {},
      );
    });

    it("GET /api/entertainment/areas 409s when the bridge isn't paired", async () => {
      const store = new Store(mkdtempSync(join(tmpdir(), "conductor-np-ent-")));
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: livingRoom().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/entertainment/areas",
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/not paired/);
    });

    it("GET /api/entertainment/areas 409s (re-pair) when the clientkey is missing", async () => {
      // seededStore() pairs without a clientkey (pre-DTLS record).
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: livingRoom().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/entertainment/areas",
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/re-run `pnpm pair`/);
    });

    it("PUT /api/settings changes only the key sent (partial update)", async () => {
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: livingRoom().driver,
      });
      const put = (body: unknown) =>
        app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: AUTH,
          payload: body,
        });
      await put({ listeningRoomId: "1" });
      const res = await put({ entertainmentAreaId: "area-9" });
      const settings = res.json();
      expect(settings.entertainmentAreaId).toBe("area-9");
      expect(settings.listeningRoomId).toBe("1"); // untouched by the partial PUT
    });
  });

  describe("playback introspection (issue #54)", () => {
    const ALBUM = {
      metadata: { name: "Purple Rain", artist: "Prince", year: 1984 },
      palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
      pattern: { type: "static", params: {} },
    };
    const build = (albums: Record<string, unknown>, room = true) => {
      const store = seededStore();
      if (room) store.setListeningRoom("1");
      return buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: livingRoom().driver,
        timers: new FakeTimers(),
        assets: { read: async (id: string) => (albums[id] ?? null) as never },
      });
    };
    const scanStart = {
      event: "start",
      uri: "curator:album:2k7bxq9m",
      tagUid: "x",
      at: "t",
    };
    const get = (app: ReturnType<typeof buildServer>["app"], url: string) =>
      app.inject({ method: "GET", url, headers: AUTH });
    const post = (
      app: ReturnType<typeof buildServer>["app"],
      payload: unknown,
    ) =>
      app.inject({ method: "POST", url: "/api/scan", headers: AUTH, payload });

    it("current is empty when idle", async () => {
      const { app } = build({});
      expect((await get(app, "/api/playback/current")).json().playback).toEqual(
        [],
      );
    });

    it("current reports the album playing after a scan", async () => {
      const { app } = build({ "2k7bxq9m": ALBUM });
      await post(app, scanStart);
      const [p] = (await get(app, "/api/playback/current")).json().playback;
      expect(p).toMatchObject({
        roomId: "1",
        pattern: "static",
        source: { name: "Purple Rain", artist: "Prince" },
      });
      expect(p.playbackId).toBeTruthy();
      expect(p.startedAt).toBeTruthy();
    });

    it("history records the playback, then its stop time", async () => {
      const { app } = build({ "2k7bxq9m": ALBUM });
      await post(app, scanStart);
      let [h] = (await get(app, "/api/playback/history")).json().history;
      expect(h).toMatchObject({ roomId: "1", source: { name: "Purple Rain" } });
      expect(h.stoppedAt).toBeUndefined(); // still playing

      await post(app, { event: "stop", at: "t" });
      [h] = (await get(app, "/api/playback/history")).json().history;
      expect(h.stoppedAt).toBeTruthy();
      expect((await get(app, "/api/playback/current")).json().playback).toEqual(
        [],
      );
    });

    it("a swap closes the previous row and opens a new one, newest first; ?limit trims", async () => {
      const { app } = build({
        "2k7bxq9m": ALBUM,
        aaaa1111: { ...ALBUM, metadata: { name: "1999", artist: "Prince" } },
      });
      await post(app, scanStart); // Purple Rain
      await post(app, {
        event: "start",
        uri: "curator:album:aaaa1111",
        tagUid: "x",
        at: "t",
      }); // swap → 1999 (same session/room)

      const { history } = (await get(app, "/api/playback/history")).json();
      expect(history.map((h: { source: { name: string } }) => h.source.name)) //
        .toEqual(["1999", "Purple Rain"]); // newest first
      expect(history[0].stoppedAt).toBeUndefined(); // 1999 still playing
      expect(history[1].stoppedAt).toBeTruthy(); // Purple Rain closed by the swap

      // ?limit trims to the most recent.
      const trimmed = (await get(app, "/api/playback/history?limit=1")).json()
        .history;
      expect(trimmed).toHaveLength(1);
      expect(trimmed[0].source.name).toBe("1999");
    });

    it("requires the shared secret", async () => {
      const { app } = build({});
      const res = await app.inject({
        method: "GET",
        url: "/api/playback/current",
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
