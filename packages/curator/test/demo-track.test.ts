// The demo track (ADR 0058) — the one song a demo tag plays.
//
// Three properties this file exists to hold:
//
//  1. **The tracklist is fetched, never stored.** The choice lands on the asset; the twelve rows
//     behind it do not (the album-assets store is in git). So the picker's route is a live read, and
//     every way that read can come back empty is a 200 with a sentence, not an error — a manual
//     pressing with no Spotify URI is an ordinary state of that screen.
//  2. **Only a `spotify:track:` may be chosen.** An album URI here would be accepted by Sonos and
//     quietly play the whole record, which is the exact bug this feature exists to fix.
//  3. **Clearing is not deleting the tag's meaning.** No choice means the demo tag falls back to the
//     album, so `{ track: null }` restores card behaviour rather than making the tag silent.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import type { AlbumAsset } from "../src/albums/asset.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import { setDemoTrack } from "../src/albums/actions.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

const ID = "abcd1234";
const SPOTIFY_ID = "1C2h7mLntPSeVYciMRTF4a";

const album: FakeAlbum = {
  id: SPOTIFY_ID,
  name: "Purple Rain",
  artist: { id: "prince1", name: "Prince" },
  year: 1984,
  genres: ["funk"],
  artwork: Buffer.from("IMG"),
  tracks: [
    { id: "t1", name: "Let's Go Crazy", durationMs: 279_000 },
    { id: "t2", name: "Take Me With U", durationMs: 234_000 },
    { name: "An Unavailable Track" }, // no id → no playable URI
  ],
};

const spotifyClient = (catalog: FakeAlbum[] = [album]) =>
  new SpotifyClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: createFakeSpotify(catalog).fetch,
  });

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-demo-")));

/** An album that is on Spotify — `makeAsset` builds a manual one, which has no tracklist. */
const onSpotify = (s: AssetStore) => {
  const asset = makeAsset(ID);
  asset.metadata.source = "spotify";
  asset.metadata.spotifyUri = `spotify:album:${SPOTIFY_ID}`;
  s.save(asset);
  return asset;
};

describe("SpotifyClient.getAlbumTracks", () => {
  it("returns the album's tracks in order, with URIs the picker can store", async () => {
    const tracks = await spotifyClient().getAlbumTracks(SPOTIFY_ID);

    expect(tracks.map((t) => t.name)).toEqual([
      "Let's Go Crazy",
      "Take Me With U",
    ]);
    expect(tracks[0]).toMatchObject({
      spotifyUri: "spotify:track:t1",
      trackNumber: 1,
      discNumber: 1,
      durationMs: 279_000,
    });
  });

  it("drops tracks with no id — a row that would play nothing is not a choice", async () => {
    const tracks = await spotifyClient().getAlbumTracks(SPOTIFY_ID);
    expect(tracks.map((t) => t.name)).not.toContain("An Unavailable Track");
  });

  it("pages through a long tracklist, and stops at the page cap rather than looping", async () => {
    // 250 tracks: past the 4×50 cap, so the client must return exactly 200 and stop. An unbounded
    // follow-`next` loop is what this asserts against — Curator is always-on (CLAUDE.md).
    const long: FakeAlbum = {
      ...album,
      tracks: Array.from({ length: 250 }, (_, i) => ({
        id: `t${i}`,
        name: `Track ${i + 1}`,
      })),
    };
    const tracks = await spotifyClient([long]).getAlbumTracks(SPOTIFY_ID);

    expect(tracks).toHaveLength(200);
    expect(tracks[0]!.name).toBe("Track 1");
    expect(tracks[199]!.name).toBe("Track 200");
  });
});

describe("GET /api/albums/:curatorId/tracks", () => {
  let s: AssetStore;
  beforeEach(() => {
    s = store();
  });

  const app = (spotify?: SpotifyClient) =>
    buildServer({
      store: s,
      roadie: fakeRoadie(s),
      prober: fakeProber(),
      ...(spotify ? { spotify } : {}),
    }).app;

  it("lists the album's tracks", async () => {
    onSpotify(s);
    const res = await app(spotifyClient()).inject({
      method: "GET",
      url: `/api/albums/${ID}/tracks`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tracks.map((t: { name: string }) => t.name)).toEqual([
      "Let's Go Crazy",
      "Take Me With U",
    ]);
  });

  /**
   * ADR 0059. This used to say "This record isn't on Spotify" for anything without a URI, which is
   * false for a Discogs pressing — it usually *is* on Spotify, Curator just hadn't kept the identity
   * — and it sent this project's own user hunting for a bug in the picker. The three situations are
   * genuinely different, so they get three sentences.
   */
  describe("why there is no tracklist", () => {
    const reasonFor = async (mutate: (a: AlbumAsset) => void) => {
      const asset = makeAsset(ID);
      mutate(asset);
      s.save(asset);
      const res = await app(spotifyClient()).inject({
        method: "GET",
        url: `/api/albums/${ID}/tracks`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tracks).toEqual([]);
      return res.json().reason as string;
    };

    it("a hand-added album has no streaming identity to list from", async () => {
      expect(await reasonFor((a) => (a.metadata.source = "manual"))).toMatch(
        /added by hand/,
      );
    });

    it("an unmatched Discogs album says so, and what to do about it", async () => {
      const reason = await reasonFor((a) => {
        a.metadata.source = "discogs";
      });
      expect(reason).toMatch(/hasn't matched this/);
      expect(reason).toMatch(/backfill/);
      // The claim that was false: never assert the record itself isn't there.
      expect(reason).not.toMatch(/isn't on Spotify/);
    });

    it("a close match names what it found, so the refusal is inspectable", async () => {
      const reason = await reasonFor((a) => {
        a.metadata.source = "discogs";
        a.metadata.spotifyMatch = {
          confidence: "close",
          name: "In Rainbows Disk 2",
          artist: "Radiohead",
          matchedAt: "2026-08-08T00:00:00.000Z",
        };
      });
      expect(reason).toMatch(/near match/);
      expect(reason).toMatch(/In Rainbows Disk 2/);
    });
  });

  it("answers 200 with a reason when Spotify isn't configured at all", async () => {
    onSpotify(s);
    const res = await app().inject({
      method: "GET",
      url: `/api/albums/${ID}/tracks`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tracks).toEqual([]);
    expect(res.json().reason).toMatch(/Spotify isn't set up/);
  });

  it("reports a Spotify failure as a reason rather than failing the panel", async () => {
    onSpotify(s);
    const res = await app(spotifyClient([])).inject({
      method: "GET",
      url: `/api/albums/${ID}/tracks`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tracks).toEqual([]);
    expect(res.json().reason).toBeTruthy();
  });

  it("404s an unknown album", async () => {
    const res = await app(spotifyClient()).inject({
      method: "GET",
      url: "/api/albums/zzzzzzzz/tracks",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /api/albums/:curatorId/demo-track", () => {
  let s: AssetStore;
  const app = () =>
    buildServer({ store: s, roadie: fakeRoadie(s), prober: fakeProber() }).app;

  beforeEach(() => {
    s = store();
    onSpotify(s);
  });

  const choose = (track: unknown) =>
    app().inject({
      method: "PUT",
      url: `/api/albums/${ID}/demo-track`,
      payload: { track },
    });

  it("records the chosen track on the asset", async () => {
    const res = await choose({
      spotifyUri: "spotify:track:t2",
      name: "Take Me With U",
      trackNumber: 2,
      durationMs: 234_000,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().demoTrack).toMatchObject({
      spotifyUri: "spotify:track:t2",
      name: "Take Me With U",
      trackNumber: 2,
    });
    expect(s.read(ID)!.demoTrack).toMatchObject({
      spotifyUri: "spotify:track:t2",
    });
    expect(s.read(ID)!.demoTrack!.chosenAt).toBeTruthy();
  });

  it("replaces an earlier choice rather than accumulating", async () => {
    await choose({ spotifyUri: "spotify:track:t1", name: "Let's Go Crazy" });
    await choose({ spotifyUri: "spotify:track:t2", name: "Take Me With U" });

    expect(s.read(ID)!.demoTrack!.name).toBe("Take Me With U");
  });

  it("clears the choice with null — the tag falls back to the album, it does not go silent", async () => {
    await choose({ spotifyUri: "spotify:track:t1", name: "Let's Go Crazy" });
    const res = await choose(null);

    expect(res.statusCode).toBe(200);
    expect(res.json().demoTrack).toBeNull();
    expect(s.read(ID)!.demoTrack).toBeNull();
  });

  it("refuses an album URI — it would quietly play the whole record", async () => {
    const res = await choose({
      spotifyUri: `spotify:album:${SPOTIFY_ID}`,
      name: "Purple Rain",
    });

    expect(res.statusCode).toBe(400);
    expect(s.read(ID)!.demoTrack).toBeUndefined();
  });

  it("refuses a nameless track — the picker and the JSON must be able to say what plays", async () => {
    const res = await choose({ spotifyUri: "spotify:track:t1", name: "  " });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown album", async () => {
    const res = await app().inject({
      method: "PUT",
      url: "/api/albums/zzzzzzzz/demo-track",
      payload: { track: { spotifyUri: "spotify:track:t1", name: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * The write-race rule: an async action must land its delta on current state, not on a copy loaded
   * before someone else's save. Roadie runs on the same album while a human picks a track, so a
   * load-mutate-save here would silently drop whatever Roadie wrote in between.
   */
  it("does not clobber a concurrent write to another field", () => {
    const deps = { store: s };
    setDemoTrack(deps, ID, {
      spotifyUri: "spotify:track:t1",
      name: "Let's Go Crazy",
    });

    // Someone else (Roadie) writes a different field, through the store, after our read would have
    // happened but before our save.
    s.update(ID, (a) => {
      a.metadata.year = 1999;
    });
    setDemoTrack(deps, ID, {
      spotifyUri: "spotify:track:t2",
      name: "Take Me With U",
    });

    const saved = s.read(ID)!;
    expect(saved.demoTrack!.name).toBe("Take Me With U");
    expect(saved.metadata.year).toBe(1999);
  });

  it("is allowed in any roadie state — a demo track is a preference, not a step", () => {
    const deps = { store: s };
    s.update(ID, (a) => {
      a.roadie.state = "fresh";
    });

    expect(() =>
      setDemoTrack(deps, ID, {
        spotifyUri: "spotify:track:t1",
        name: "Let's Go Crazy",
      }),
    ).not.toThrow();
  });
});

/**
 * Naming an album on Spotify by hand (ADR 0059) — the escape hatch the picker's copy promised
 * before it existed. Two cases it serves: the matcher found nothing, and the matcher found something
 * it deliberately won't play from.
 */
describe("PUT /api/albums/:curatorId/spotify-uri", () => {
  let s: AssetStore;
  const app = () =>
    buildServer({ store: s, roadie: fakeRoadie(s), prober: fakeProber() }).app;

  beforeEach(() => {
    s = store();
    const asset = makeAsset(ID);
    asset.metadata.source = "discogs";
    s.save(asset);
  });

  const put = (spotifyUri: unknown) =>
    app().inject({
      method: "PUT",
      url: `/api/albums/${ID}/spotify-uri`,
      payload: { spotifyUri },
    });

  it("accepts the curator-scheme URI", async () => {
    const res = await put(`spotify:album:${SPOTIFY_ID}`);
    expect(res.statusCode).toBe(200);
    expect(s.read(ID)!.metadata.spotifyUri).toBe(`spotify:album:${SPOTIFY_ID}`);
  });

  /**
   * The share button gives a URL, not a URI. Refusing it would mean documenting a conversion that
   * nobody should have to perform to name an album they are looking at.
   */
  it("accepts an open.spotify.com share link, tracking parameters and all", async () => {
    const res = await put(
      `https://open.spotify.com/album/${SPOTIFY_ID}?si=abc123&nd=1`,
    );
    expect(res.statusCode).toBe(200);
    expect(s.read(ID)!.metadata.spotifyUri).toBe(`spotify:album:${SPOTIFY_ID}`);
  });

  it("accepts a localised share link", async () => {
    await put(`https://open.spotify.com/intl-de/album/${SPOTIFY_ID}`);
    expect(s.read(ID)!.metadata.spotifyUri).toBe(`spotify:album:${SPOTIFY_ID}`);
  });

  /** A hand-entered URI is a fact, so the record of a guess beside it would only confuse the UI. */
  it("drops the recorded match — a human's answer replaces the guess", async () => {
    s.update(ID, (a) => {
      a.metadata.spotifyMatch = {
        confidence: "close",
        name: "Something Else",
        artist: "Someone Else",
        matchedAt: "2026-08-08T00:00:00.000Z",
      };
    });
    await put(`spotify:album:${SPOTIFY_ID}`);
    expect(s.read(ID)!.metadata.spotifyMatch).toBeUndefined();
  });

  /** Clearing disowns the album, so a demo cut naming one of its tracks can't be trusted either. */
  it("clearing removes the URI and the demo cut with it", async () => {
    await put(`spotify:album:${SPOTIFY_ID}`);
    s.update(ID, (a) => {
      a.demoTrack = {
        spotifyUri: "spotify:track:t1",
        name: "A Song",
        chosenAt: "2026-08-08T00:00:00.000Z",
      };
    });

    const res = await put(null);
    expect(res.statusCode).toBe(200);
    expect(s.read(ID)!.metadata.spotifyUri).toBeUndefined();
    expect(s.read(ID)!.demoTrack).toBeNull();
  });

  it("refuses anything that isn't a Spotify album, and says what it wants", async () => {
    for (const bad of [
      "not a link",
      "https://open.spotify.com/track/abc123", // a track, not an album
      "spotify:track:abc123",
      "https://music.apple.com/album/123",
    ]) {
      const res = await put(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toMatch(/spotify:album/);
    }
    expect(s.read(ID)!.metadata.spotifyUri).toBeUndefined();
  });

  it("404s an unknown album", async () => {
    const res = await app().inject({
      method: "PUT",
      url: "/api/albums/zzzzzzzz/spotify-uri",
      payload: { spotifyUri: `spotify:album:${SPOTIFY_ID}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
