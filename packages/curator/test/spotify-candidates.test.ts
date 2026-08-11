// The albums a record could be — GET /api/albums/:curatorId/spotify-candidates
// ([#289](https://github.com/dylanleatham/Marquee/issues/289)).
//
// ADR 0067 taught the matcher to refuse an artist's several same-titled albums. This route is the
// way out of that refusal: it re-runs the same search through the same `bestSpotifyMatch` and hands
// back the set it declined to choose between, so the record page offers exactly those. The
// alternative — filtering search results in the UI — would be a second implementation of "which
// albums are indistinguishable", and the two would drift the first time the rule changed.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient, SpotifyError } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

const ID = "abcd1234";

/** Weezer's self-titled albums, which is the whole reason this route exists. */
const weezer = (id: string, year: number): FakeAlbum => ({
  id,
  name: "Weezer",
  artist: { id: "weezer", name: "Weezer" },
  year,
  genres: ["rock"],
  artwork: Buffer.from("IMG"),
  tracks: [{ id: `${id}-t1`, name: "A Song", durationMs: 200_000 }],
});

const CATALOG = [
  weezer("blue", 1994),
  weezer("green", 2001),
  weezer("teal", 2019),
];

const spotifyClient = (catalog: FakeAlbum[] = CATALOG) =>
  new SpotifyClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: createFakeSpotify(catalog).fetch,
  });

describe("GET /api/albums/:curatorId/spotify-candidates", () => {
  let s: AssetStore;
  beforeEach(() => {
    s = new AssetStore(mkdtempSync(join(tmpdir(), "curator-cand-")));
  });

  const app = (spotify?: SpotifyClient) =>
    buildServer({
      store: s,
      roadie: fakeRoadie(s),
      prober: fakeProber(),
      ...(spotify ? { spotify } : {}),
    }).app;

  /** A Discogs pressing of one of six identically-named records. */
  const seed = (year = 2020) => {
    const asset = makeAsset(ID, "Weezer", "Weezer");
    asset.metadata.source = "discogs";
    asset.metadata.year = year;
    s.save(asset);
  };

  const get = async (spotify?: SpotifyClient) => {
    const res = await app(spotify).inject({
      method: "GET",
      url: `/api/albums/${ID}/spotify-candidates`,
    });
    return { status: res.statusCode, body: res.json() };
  };

  it("offers every same-titled album the matcher would not choose between", async () => {
    seed();
    const { status, body } = await get(spotifyClient());

    expect(status).toBe(200);
    expect(body.candidates.map((c: { year: number }) => c.year)).toEqual([
      1994, 2001, 2019,
    ]);
  });

  /**
   * The list is the matcher's, not the search's. An unrelated album by the same artist comes back
   * from the same query and must not pad the picker — the question is "which of these is yours",
   * and a row that could never be the answer makes it harder, not easier.
   */
  it("leaves out albums that were never in the tie", async () => {
    seed();
    const pinkerton: FakeAlbum = {
      id: "pink",
      name: "Pinkerton",
      artist: { id: "weezer", name: "Weezer" },
      year: 1996,
      genres: ["rock"],
      artwork: Buffer.from("IMG"),
      tracks: [{ id: "p1", name: "Tired of Sex", durationMs: 200_000 }],
    };
    const { body } = await get(spotifyClient([...CATALOG, pinkerton]));

    expect(body.candidates.map((c: { name: string }) => c.name)).not.toContain(
      "Pinkerton",
    );
  });

  /**
   * A record that *did* match still gets its one album back. This route answers "what could this
   * be", and seeing what it settled on is what makes replacing it a considered act rather than a
   * blind overwrite — the same reason ADR 0060 made the control visible whether or not a match
   * exists.
   */
  it("offers the single album when the matcher did settle on one", async () => {
    seed(1994); // the year lands, so ADR 0067 lets the match through
    const { body } = await get(spotifyClient());

    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].year).toBe(1994);
  });

  it("is 404 for a record that isn't there", async () => {
    const res = await app(spotifyClient()).inject({
      method: "GET",
      url: "/api/albums/nosuchid1/spotify-candidates",
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * Always 200 with a reason, like the tracklist route: an empty picker is an ordinary state of
   * this panel, and a 4xx would make it look broken on a workstation that simply has no Spotify
   * credentials.
   */
  it("says why rather than failing when Spotify isn't configured", async () => {
    seed();
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
    expect(body.reason).toMatch(/isn't configured/);
  });

  it("says why rather than failing when nothing comes back", async () => {
    seed();
    const { status, body } = await get(spotifyClient([]));

    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
    expect(body.reason).toBeTruthy();
  });

  /**
   * The case "always 200" is actually *for*. An empty catalogue is a quiet success; a live Spotify
   * failure is the one that used to escape as a 502/504 and make the picker look broken on a page
   * that is merely waiting on someone else's server. Caught by spec-adherence, which noticed the
   * route's own docstring promised something its `catch` didn't deliver — there was no test here at
   * all, which is why nothing else did.
   */
  it("stays 200 with a reason when Spotify itself fails", async () => {
    seed();
    const exploding = {
      searchAlbums: async () => {
        throw new SpotifyError("Spotify API 503 on /v1/search", 503);
      },
    } as unknown as SpotifyClient;

    const { status, body } = await get(exploding);

    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
    expect(body.reason).toMatch(/503/);
  });
});
