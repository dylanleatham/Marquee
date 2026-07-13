import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { addSpotifyAlbum, parseAlbumId } from "../src/albums/add-spotify.js";
import { fakeGenerate } from "./helpers.js";

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
  it("fetches metadata + art and writes a spotify-sourced asset", async () => {
    const fs = createFakeSpotify([album()]);
    const s = store();
    const { curatorId, asset } = await addSpotifyAlbum(
      { store: s, spotify: client(fs), generate: fakeGenerate },
      { spotifyUri: `spotify:album:${ID}` },
    );
    expect(asset.metadata).toMatchObject({
      source: "spotify",
      name: "Purple Rain",
      artist: "Prince",
      year: 1984,
      spotifyUri: `spotify:album:${ID}`,
    });
    expect(asset.metadata.genres).toEqual(["funk"]);
    expect(asset.metadata.spotifyArtUrl).toContain("i.scdn.co");
    expect(existsSync(s.paths.artworkFile(curatorId))).toBe(true);
    expect(s.read(curatorId)?.roadie.state).toBe("awaiting_review");
  });

  it("rejects a duplicate (same Spotify URI) with the existing curatorId", async () => {
    const fs = createFakeSpotify([album()]);
    const s = store();
    const c = client(fs);
    const first = await addSpotifyAlbum(
      { store: s, spotify: c, generate: fakeGenerate },
      { spotifyId: ID },
    );
    await expect(
      addSpotifyAlbum(
        { store: s, spotify: c, generate: fakeGenerate },
        { spotifyId: ID },
      ),
    ).rejects.toMatchObject({
      name: "DuplicateAlbumError",
      curatorId: first.curatorId,
    });
  });

  it("[integration] real Palette Press on the fetched cover → purple-led palette", async () => {
    const fs = createFakeSpotify([album(purpleRain)]);
    const s = store();
    const { curatorId } = await addSpotifyAlbum(
      { store: s, spotify: client(fs) },
      { spotifyId: ID },
    );
    const asset = s.read(curatorId)!;
    expect(asset.palette.colors.length).toBeGreaterThanOrEqual(2);
    const n = Number.parseInt(asset.palette.colors[0]!.hex.slice(1), 16);
    expect(n & 0xff).toBeGreaterThan((n >> 8) & 0xff); // blue > green → purple-led
  });
});
