import { describe, it, expect } from "vitest";
import { createFakeSpotify, type FakeAlbum } from "../src/index.js";

const album: FakeAlbum = {
  id: "1C2h7mLntPSeVYciMRTF4a",
  name: "Purple Rain",
  artist: { id: "5a2EaR3hamoenG9rDuVn8j", name: "Prince" },
  year: 1984,
  genres: ["funk", "pop"],
  artwork: Buffer.from("JPEGDATA"),
};

const withToken = { headers: { Authorization: "Bearer fake-token" } };

describe("fake-spotify", () => {
  it("issues a token for Basic auth and rejects without it", async () => {
    const fs = createFakeSpotify();
    const bad = await fs.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
    });
    expect(bad.status).toBe(401);
    const ok = await fs.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: "Basic abc" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toBe("fake-token");
    expect(fs.tokenRequests()).toBe(2);
  });

  it("requires a bearer token on the Web API", async () => {
    const fs = createFakeSpotify([album]);
    const res = await fs.fetch(`https://api.spotify.com/v1/albums/${album.id}`);
    expect(res.status).toBe(401);
  });

  it("returns album, artist genres, search, and art bytes", async () => {
    const fs = createFakeSpotify([album]);

    const a = await (
      await fs.fetch(`https://api.spotify.com/v1/albums/${album.id}`, withToken)
    ).json();
    expect(a.name).toBe("Purple Rain");
    expect(a.release_date).toBe("1984-01-01");
    expect(a.artists[0].name).toBe("Prince");
    expect(a.images[0].url).toBe(fs.imageUrl(album.id));

    const ar = await (
      await fs.fetch(
        `https://api.spotify.com/v1/artists/${album.artist.id}`,
        withToken,
      )
    ).json();
    expect(ar.genres).toEqual(["funk", "pop"]);

    const s = await (
      await fs.fetch(
        "https://api.spotify.com/v1/search?type=album&q=purple",
        withToken,
      )
    ).json();
    expect(s.albums.items.map((i: { id: string }) => i.id)).toEqual([album.id]);

    const img = await fs.fetch(fs.imageUrl(album.id), withToken);
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe("JPEGDATA");
  });

  it("404s an unknown album", async () => {
    const fs = createFakeSpotify();
    expect(
      (await fs.fetch("https://api.spotify.com/v1/albums/nope", withToken))
        .status,
    ).toBe(404);
  });
});
