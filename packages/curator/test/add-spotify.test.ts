import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { addSpotifyAlbum, parseAlbumId } from "../src/albums/add-spotify.js";
import { fakeRoadie } from "./helpers.js";

const ID = "1C2h7mLntPSeVYciMRTF4a";
const here = dirname(fileURLToPath(import.meta.url));
const purpleRain = readFileSync(
  join(here, "..", "..", "..", "fixtures", "artwork", "purple-rain.jpg"),
);

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-sp-")));
const album = (artwork = Buffer.from("IMG")): FakeAlbum => ({
  id: ID,
  name: "Purple Rain",
  artist: { id: "prince1", name: "Prince" },
  year: 1984,
  genres: ["funk"],
  artwork,
});
const client = (fs: ReturnType<typeof createFakeSpotify>) =>
  new SpotifyClient({ clientId: "id", clientSecret: "s", fetch: fs.fetch });

describe("parseAlbumId", () => {
  it("accepts a uri or a raw id, rejects junk", () => {
    expect(parseAlbumId({ spotifyUri: "spotify:album:abc123" })).toBe("abc123");
    expect(parseAlbumId({ spotifyId: "xyz" })).toBe("xyz");
    expect(parseAlbumId({ spotifyUri: "not-a-uri" })).toBeNull();
    expect(parseAlbumId({})).toBeNull();
  });
});

describe("addSpotifyAlbum", () => {
  it("queues a fresh spotify asset, then Roadie fetches metadata + art + palette", async () => {
    const fs = createFakeSpotify([album()]);
    const s = store();
    const roadie = fakeRoadie(s, { spotify: client(fs) });
    const { curatorId, asset } = await addSpotifyAlbum(
      { store: s, roadie },
      { spotifyUri: `spotify:album:${ID}` },
    );

    // Queued immediately with only the URI known — metadata arrives during processing.
    expect(asset.roadie.state).toBe("fetching_metadata");
    expect(asset.metadata.name).toBe("");

    await roadie.drain();

    const done = s.read(curatorId)!;
    expect(done.metadata).toMatchObject({
      source: "spotify",
      name: "Purple Rain",
      artist: "Prince",
      year: 1984,
      spotifyUri: `spotify:album:${ID}`,
    });
    expect(done.metadata.genres).toEqual(["funk"]);
    expect(done.metadata.spotifyArtUrl).toContain("i.scdn.co");
    expect(existsSync(s.paths.artworkFile(curatorId))).toBe(true);
    // ADR 0027: onboarding stops at the palette; prompts are drafted on request.
    expect(done.promptDrafts).toBeUndefined();
    expect(done.roadie.state).toBe("awaiting_review");
  });

  it("rejects a duplicate (same Spotify URI) up front, without a fetch", async () => {
    const fs = createFakeSpotify([album()]);
    const s = store();
    const roadie = fakeRoadie(s, { spotify: client(fs) });
    const first = await addSpotifyAlbum(
      { store: s, roadie },
      { spotifyId: ID },
    );
    await roadie.drain();
    await expect(
      addSpotifyAlbum({ store: s, roadie }, { spotifyId: ID }),
    ).rejects.toMatchObject({
      name: "DuplicateAlbumError",
      curatorId: first.curatorId,
    });
  });

  it("parks a 404 album at needs_manual with the album_not_on_spotify reason", async () => {
    const fs = createFakeSpotify([]); // empty catalog → every album 404s
    const s = store();
    const roadie = fakeRoadie(s, { spotify: client(fs) });
    const { curatorId } = await addSpotifyAlbum(
      { store: s, roadie },
      { spotifyId: "doesnotexist1" },
    );
    await roadie.drain();

    const asset = s.read(curatorId)!;
    expect(asset.roadie.state).toBe("needs_manual");
    expect(asset.roadie.flags.album_not_on_spotify).toBe(true);
    expect(asset.roadie.lastError?.reason).toBe("album_not_on_spotify");
  });

  it("[integration] real Palette Press on the fetched cover → purple-led palette", async () => {
    const fs = createFakeSpotify([album(purpleRain)]);
    const s = store();
    const roadie = fakeRoadie(s, { spotify: client(fs), generate: undefined });
    const { curatorId } = await addSpotifyAlbum(
      { store: s, roadie },
      { spotifyId: ID },
    );
    await roadie.drain();

    const asset = s.read(curatorId)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.palette!.colors.length).toBeGreaterThanOrEqual(2);
    const n = Number.parseInt(asset.palette!.colors[0]!.hex.slice(1), 16);
    expect(n & 0xff).toBeGreaterThan((n >> 8) & 0xff); // blue > green → purple-led
  });
});
