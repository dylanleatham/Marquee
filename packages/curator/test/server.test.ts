import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import { fakeGenerate, buildMultipart } from "./helpers.js";

const spotifyAlbum: FakeAlbum = {
  id: "abc12345",
  name: "Kind of Blue",
  artist: { id: "miles1", name: "Miles Davis" },
  year: 1959,
  genres: ["jazz"],
  artwork: Buffer.from("IMG"),
};
const buildWithSpotify = () => {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-sp-")));
  const fs = createFakeSpotify([spotifyAlbum]);
  const spotify = new SpotifyClient({
    clientId: "id",
    clientSecret: "s",
    fetch: fs.fetch,
  });
  const { app } = buildServer({ store, generate: fakeGenerate, spotify });
  return { app, store };
};

const build = () => {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-srv-")));
  const { app } = buildServer({ store, generate: fakeGenerate });
  return { app, store };
};

const addAlbum = (
  app: ReturnType<typeof build>["app"],
  name: string,
  artist: string,
) => {
  const mp = buildMultipart(
    { name, artist },
    {
      field: "artwork",
      filename: "art.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("fake"),
    },
  );
  return app.inject({
    method: "POST",
    url: "/api/albums",
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
};

describe("Curator HTTP API", () => {
  it("/healthz reports ok", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, albums: 0 });
  });

  it("POST /api/albums (manual, multipart) creates the album and returns 201", async () => {
    const { app, store } = build();
    const res = await addAlbum(app, "Purple Rain", "Prince");
    expect(res.statusCode).toBe(201);
    const { curatorId, state, paletteColors } = res.json();
    expect(curatorId).toMatch(/^[a-z0-9]{8}$/);
    expect(state).toBe("awaiting_review");
    expect(paletteColors).toBe(2);
    expect(store.read(curatorId)?.metadata.name).toBe("Purple Rain");
  });

  it("400s a multipart POST with no artwork file; 503s a JSON POST when Spotify is unconfigured", async () => {
    const { app } = build();
    const noFile = buildMultipart({ name: "X", artist: "Y" });
    const r400 = await app.inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": noFile.contentType },
      payload: noFile.body,
    });
    expect(r400.statusCode).toBe(400);

    // Non-multipart body → Spotify path, which 503s without configured creds.
    const r503 = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyId: "x" },
    });
    expect(r503.statusCode).toBe(503);
  });

  it("lists, fetches one, 404s on missing, and deletes", async () => {
    const { app, store } = build();
    const { curatorId } = (
      await addAlbum(app, "Kind of Blue", "Miles Davis")
    ).json();

    const list = await app.inject({ method: "GET", url: "/api/albums" });
    expect(list.json().albums).toHaveLength(1);
    expect(list.json().albums[0]).toMatchObject({
      title: "Kind of Blue",
      source: "manual",
    });

    const one = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}`,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().curatorId).toBe(curatorId);

    expect(
      (await app.inject({ method: "GET", url: "/api/albums/zzzzzzzz" }))
        .statusCode,
    ).toBe(404);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/albums/${curatorId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(store.read(curatorId)).toBeNull();
    expect(
      (await app.inject({ method: "DELETE", url: `/api/albums/${curatorId}` }))
        .statusCode,
    ).toBe(404);
  });
});

describe("Curator Spotify API", () => {
  it("healthz reflects whether Spotify is configured", async () => {
    expect(
      (await build().app.inject({ method: "GET", url: "/healthz" })).json()
        .spotify,
    ).toBe(false);
    expect(
      (
        await buildWithSpotify().app.inject({ method: "GET", url: "/healthz" })
      ).json().spotify,
    ).toBe(true);
  });

  it("503s the Spotify routes when unconfigured", async () => {
    const { app } = build();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/spotify/search-albums?q=x",
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ method: "GET", url: "/api/spotify/album/abc12345" }))
        .statusCode,
    ).toBe(503);
  });

  it("searches and previews albums", async () => {
    const { app } = buildWithSpotify();
    const search = await app.inject({
      method: "GET",
      url: "/api/spotify/search-albums?q=blue",
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results[0].name).toBe("Kind of Blue");

    const preview = await app.inject({
      method: "GET",
      url: "/api/spotify/album/abc12345",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      name: "Kind of Blue",
      artist: "Miles Davis",
      year: 1959,
    });
  });

  it("adds via a JSON body and rejects duplicates with the existing curatorId", async () => {
    const { app, store } = buildWithSpotify();
    const add = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyUri: "spotify:album:abc12345" },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({
      source: "spotify",
      state: "awaiting_review",
    });
    const curatorId = add.json().curatorId;
    expect(store.read(curatorId)?.metadata.source).toBe("spotify");

    const dup = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyId: "abc12345" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().curatorId).toBe(curatorId);
  });

  it("404s adding a nonexistent album", async () => {
    const { app } = buildWithSpotify();
    const res = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyId: "doesnotexist" },
    });
    expect(res.statusCode).toBe(404);
  });
});
