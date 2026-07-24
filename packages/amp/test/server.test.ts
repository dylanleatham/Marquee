import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { SonosUnavailableError } from "../src/sonos/driver.js";
import type { AlbumAssetReader, AlbumSpotifyInput } from "../src/assets.js";
import { FakeSonosDriver, FakeTimers } from "./fakes.js";

const SECRET = "s3cret";
const ID = "2k7bxq9m";
const SPOTIFY = "spotify:album:1DFixLWuPkv3KT3TnV35m3";
const auth = { "x-trigger-secret": SECRET };
const startCard = {
  event: "start",
  uri: `curator:card:${ID}`,
  tagUid: "04:A1",
  at: "t",
};
const startSleeve = {
  event: "start",
  uri: `curator:album:${ID}`,
  tagUid: "04:A1",
  at: "t",
};

/** In-memory album reader (mirrors conductor's test reader). */
function reader(albums: Record<string, AlbumSpotifyInput>): AlbumAssetReader {
  return { read: async (id) => albums[id] ?? null };
}

/** A Store seeded with a target room, in a throwaway data dir. */
function tmpStore(targetRoom: string | null): Store {
  return new Store(mkdtempSync(join(tmpdir(), "amp-store-")), targetRoom);
}

interface BuildArgs {
  target?: string | null;
  albums?: Record<string, AlbumSpotifyInput>;
  driver?: FakeSonosDriver;
  timers?: FakeTimers;
  idleTimeoutMinutes?: number;
}

function build(args: BuildArgs = {}) {
  const driver = args.driver ?? new FakeSonosDriver();
  const timers = args.timers ?? new FakeTimers();
  const { app } = buildServer({
    config: {
      sharedSecret: SECRET,
      idleTimeoutMinutes: args.idleTimeoutMinutes ?? 90,
    },
    store: tmpStore(args.target === undefined ? "Living Room" : args.target),
    driver,
    timers,
    assets: reader(
      args.albums ?? {
        [ID]: { metadata: { name: "X", artist: "Y", spotifyUri: SPOTIFY } },
      },
    ),
  });
  return { app, driver, timers };
}

describe("Amp /api/scan", () => {
  it("healthz is open (no secret) and returns ok", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects a scan without the shared secret (401)", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: startCard,
    });
    expect(res.statusCode).toBe(401);
  });

  it("a card scan plays the album on Sonos", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      action: "playing",
      curatorId: ID,
      spotifyUri: SPOTIFY,
    });
    expect(driver.playCalls).toEqual([
      { target: "Living Room", spotifyUri: SPOTIFY },
    ]);
  });

  it("a sleeve scan is ignored — Amp stays silent (vinyl plays)", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startSleeve,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "sleeve — vinyl plays",
    });
    expect(driver.playCalls).toHaveLength(0);
  });

  it("a card for an album not in the synced store is ignored", async () => {
    const { app, driver } = build({ albums: {} });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "album not synced",
    });
    expect(driver.playCalls).toHaveLength(0);
  });

  it("a card for an album with no Spotify URI is ignored", async () => {
    const { app, driver } = build({
      albums: { [ID]: { metadata: { name: "X", artist: "Y" } } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "album not on spotify",
    });
    expect(driver.playCalls).toHaveLength(0);
  });

  it("a card scan with no target room configured is ignored", async () => {
    const { app, driver } = build({ target: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "no target room",
    });
    expect(driver.playCalls).toHaveLength(0);
  });

  it("degrades to 202 (not error) when Sonos is unavailable", async () => {
    const driver = new FakeSonosDriver({
      failPlay: new SonosUnavailableError("no favorite"),
    });
    const { app } = build({ driver });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "sonos unavailable",
    });
  });

  it("a non-SonosUnavailable driver error surfaces as 502", async () => {
    const driver = new FakeSonosDriver({ failPlay: new Error("boom") });
    const { app } = build({ driver });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(res.statusCode).toBe(502);
  });

  it("a stop scan stops Sonos", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: { event: "stop", at: "t" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      action: "stopped",
      target: "Living Room",
    });
    expect(driver.stopCalls).toEqual(["Living Room"]);
  });

  it("a stop with no target room is ignored", async () => {
    const { app, driver } = build({ target: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: { event: "stop", at: "t" },
    });
    expect(res.json()).toMatchObject({
      action: "ignored",
      reason: "no target room",
    });
    expect(driver.stopCalls).toHaveLength(0);
  });

  it("a malformed body is a 400", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: { event: "start" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a non-curator URI is a 400", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: {
        event: "start",
        uri: "curator:disc:2k7bxq9m",
        tagUid: "04:A1",
        at: "t",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("the idle timeout stops playback (lost-stop safety net)", async () => {
    const timers = new FakeTimers();
    const { app, driver } = build({ timers, idleTimeoutMinutes: 1 });
    await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    expect(timers.activeAt(60_000)).toBe(1);
    timers.fire(60_000);
    expect(driver.stopCalls).toEqual(["Living Room"]);
  });
});

describe("Amp settings", () => {
  it("PUT then GET round-trips the target room", async () => {
    const { app } = build({ target: null });
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth,
      payload: { targetRoom: "Kitchen" },
    });
    expect(put.json()).toMatchObject({ targetRoom: "Kitchen" });
    const get = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: auth,
    });
    expect(get.json()).toMatchObject({ targetRoom: "Kitchen" });
  });

  it("lists Sonos rooms from the driver", async () => {
    const { app } = build({
      driver: new FakeSonosDriver({ rooms: ["Living Room", "Kitchen"] }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/sonos/rooms",
      headers: auth,
    });
    expect(res.json()).toEqual({ rooms: ["Living Room", "Kitchen"] });
  });
});
