import { describe, it, expect } from "vitest";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { SpotifyClient, type FetchLike } from "../src/spotify/client.js";

const album: FakeAlbum = {
  id: "1C2h7mLntPSeVYciMRTF4a",
  name: "Purple Rain",
  artist: { id: "prince1", name: "Prince" },
  year: 1984,
  genres: ["funk", "pop"],
  artwork: Buffer.from("IMG"),
};

const client = (fs = createFakeSpotify([album])) =>
  new SpotifyClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: fs.fetch,
  });

describe("SpotifyClient", () => {
  it("getAlbum normalizes metadata and pulls genres from the artist endpoint", async () => {
    const meta = await client().getAlbum(album.id);
    expect(meta).toMatchObject({
      spotifyId: album.id,
      spotifyUri: `spotify:album:${album.id}`,
      name: "Purple Rain",
      artist: "Prince",
      year: 1984,
      genres: ["funk", "pop"],
    });
    expect(meta.artUrl).toContain("i.scdn.co");
  });

  it("caches the access token across calls", async () => {
    const fs = createFakeSpotify([album]);
    const c = client(fs);
    await c.getAlbum(album.id); // token + album + artist
    await c.searchAlbums("purple"); // reuses token
    expect(fs.tokenRequests()).toBe(1);
  });

  it("throws SpotifyError(404) for a missing album", async () => {
    await expect(client().getAlbum("nope")).rejects.toMatchObject({
      name: "SpotifyError",
      status: 404,
    });
  });

  it("searchAlbums returns candidates", async () => {
    const results = await client().searchAlbums("prince");
    expect(results.map((a) => a.name)).toContain("Purple Rain");
  });

  it("downloadArt returns the cover bytes", async () => {
    const fs = createFakeSpotify([album]);
    const buf = await client(fs).downloadArt(fs.imageUrl(album.id));
    expect(buf.toString()).toBe("IMG");
  });

  it("times out a hung request (504) instead of hanging forever", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const c = new SpotifyClient({
      clientId: "id",
      clientSecret: "s",
      fetch: hanging,
      timeoutMs: 20,
    });
    await expect(c.getAlbum("x")).rejects.toMatchObject({
      name: "SpotifyError",
      status: 504,
    });
  });
});
