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
const startDemo = {
  event: "start",
  uri: `curator:demo:${ID}`,
  tagUid: "04:A1",
  at: "t",
};
const TRACK = "spotify:track:4bz7uB4edifWKJXSDxwHcs";

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

  /**
   * The demo tag (ADR 0058). It is the card path with one substitution — the album's chosen track
   * instead of the album — so these cover the substitution itself, the fallback when no choice has
   * been made, and the two degradations that must behave identically to a card's.
   */
  describe("a demo scan", () => {
    const withTrack = {
      [ID]: {
        metadata: { name: "X", artist: "Y", spotifyUri: SPOTIFY },
        demoTrack: {
          spotifyUri: TRACK,
          name: "Let's Go Crazy",
          trackNumber: 4,
        },
      },
    };

    const scan = (albums?: Record<string, AlbumSpotifyInput>) => {
      const built = build(albums ? { albums } : {});
      return built.app
        .inject({
          method: "POST",
          url: "/api/scan",
          headers: auth,
          payload: startDemo,
        })
        .then((res) => ({ res, driver: built.driver }));
    };

    /**
     * **The chosen cut is played as a position in the album, not as a track handed over on its own**
     * ([ADR 0076](../../../docs/adrs/0076-a-demo-cut-plays-as-a-position-in-the-album.md)).
     *
     * Sonos accepts a bare `x-sonos-spotify:` track, resolves it, reports the right duration, puts it
     * in the queue — and will not start it. `Play()` answers `true` and the transport stays `STOPPED`,
     * so nothing in Amp had anything to report: the room simply went quiet. Enqueuing the album
     * container and seeking to the track plays the byte-identical track URI. Measured on the
     * maintainer's household, 2026-08-12, both ways round.
     *
     * So the driver is handed **the album and a 1-based position**, which is why `spotifyUri` in the
     * response is now the album: it names what Sonos was given, and `demoTrack` names the cut.
     */
    it("plays the chosen cut as a position within the album", async () => {
      const { res, driver } = await scan(withTrack);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        action: "playing",
        curatorId: ID,
        spotifyUri: SPOTIFY,
        demoTrack: TRACK,
        trackNumber: 4,
      });
      expect(driver.playCalls).toEqual([
        { target: "Living Room", spotifyUri: SPOTIFY, trackNumber: 4 },
      ]);
    });

    /**
     * A cut chosen before Curator recorded track numbers, or on an album whose position we never
     * learned. The container trick needs a position, so this falls back to handing Sonos the track
     * itself — the pre-ADR 0076 behaviour, which works on some households and is silent on others.
     * Better than refusing to play a cut we can name, and logged so the silence has a reason.
     */
    it("hands over the bare track when the cut has no track number", async () => {
      const { res, driver } = await scan({
        [ID]: {
          metadata: { name: "X", artist: "Y", spotifyUri: SPOTIFY },
          demoTrack: { spotifyUri: TRACK, name: "Let's Go Crazy" },
        },
      });

      expect(res.json()).toMatchObject({
        action: "playing",
        spotifyUri: TRACK,
        demoTrack: TRACK,
      });
      expect(res.json().trackNumber).toBeUndefined();
      expect(driver.playCalls).toEqual([
        { target: "Living Room", spotifyUri: TRACK },
      ]);
    });

    /**
     * No choice yet → the whole album, exactly as a card. A tag that did nothing would be
     * indistinguishable from a mis-written one; a record playing from track 1 is wrong in a way you
     * can hear and fix. `demoTrack: null` in the response is how a caller tells the two apart.
     */
    it("falls back to the whole album when no track has been chosen", async () => {
      const { res, driver } = await scan();

      expect(res.json()).toMatchObject({
        action: "playing",
        spotifyUri: SPOTIFY,
        demoTrack: null,
      });
      expect(driver.playCalls).toEqual([
        { target: "Living Room", spotifyUri: SPOTIFY },
      ]);
    });

    it("falls back to the album when the choice was explicitly cleared", async () => {
      const { res } = await scan({
        [ID]: {
          metadata: { name: "X", artist: "Y", spotifyUri: SPOTIFY },
          demoTrack: null,
        },
      });
      expect(res.json()).toMatchObject({
        spotifyUri: SPOTIFY,
        demoTrack: null,
      });
    });

    /**
     * A chosen track outlives the album's own Spotify URI being absent — the track is what plays, so
     * "album not on spotify" would be the wrong answer to give a demo tag that knows its song.
     */
    it("plays the chosen track even when the album has no Spotify URI", async () => {
      const { res } = await scan({
        [ID]: {
          metadata: { name: "X", artist: "Y" },
          demoTrack: { spotifyUri: TRACK },
        },
      });
      expect(res.json()).toMatchObject({
        action: "playing",
        spotifyUri: TRACK,
      });
    });

    it("is ignored when there is neither a chosen track nor a Spotify album", async () => {
      const { res, driver } = await scan({
        [ID]: { metadata: { name: "X", artist: "Y" } },
      });
      expect(res.json()).toMatchObject({
        action: "ignored",
        reason: "album not on spotify",
      });
      expect(driver.playCalls).toHaveLength(0);
    });

    it("is ignored when the album isn't in the synced store", async () => {
      const { res, driver } = await scan({});
      expect(res.json()).toMatchObject({
        action: "ignored",
        reason: "album not synced",
      });
      expect(driver.playCalls).toHaveLength(0);
    });
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

describe("Amp admin + status", () => {
  it("POST /api/admin/play plays on the target", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/play",
      headers: auth,
      payload: { spotifyUri: SPOTIFY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      target: "Living Room",
      spotifyUri: SPOTIFY,
    });
    expect(driver.playCalls).toEqual([
      { target: "Living Room", spotifyUri: SPOTIFY },
    ]);
  });

  it("POST /api/admin/play rejects a non-spotify:album URI (400)", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/play",
      headers: auth,
      payload: { spotifyUri: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(driver.playCalls).toHaveLength(0);
  });

  it("POST /api/admin/play with no target configured is a 400", async () => {
    const { app } = build({ target: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/play",
      headers: auth,
      payload: { spotifyUri: SPOTIFY },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/admin/stop stops the target", async () => {
    const { app, driver } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/stop",
      headers: auth,
      payload: {},
    });
    expect(res.json()).toMatchObject({ ok: true, target: "Living Room" });
    expect(driver.stopCalls).toEqual(["Living Room"]);
  });

  it("GET /api/status reports idle state and the target", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: auth,
    });
    expect(res.json()).toMatchObject({ state: "idle", target: "Living Room" });
  });

  it("GET /api/status reflects a playing card", async () => {
    const { app } = build();
    await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: auth,
      payload: startCard,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: auth,
    });
    expect(res.json()).toMatchObject({
      state: "playing",
      playing: { curatorId: ID, spotifyUri: SPOTIFY },
    });
  });
});
