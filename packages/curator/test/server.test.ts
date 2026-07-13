import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import { fakeGenerate, fakeRoadie, buildMultipart } from "./helpers.js";

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
  // Inject a fake-time Roadie so adds complete synchronously under drain().
  const roadie = fakeRoadie(store, { spotify });
  const { app } = buildServer({ store, spotify, roadie });
  return { app, store, roadie };
};

const build = () => {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-srv-")));
  const roadie = fakeRoadie(store);
  const { app } = buildServer({ store, generate: fakeGenerate, roadie });
  return { app, store, roadie };
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

  it("POST /api/albums (manual) queues the album, and Roadie drives it to awaiting_review", async () => {
    const { app, store, roadie } = build();
    const res = await addAlbum(app, "Purple Rain", "Prince");
    expect(res.statusCode).toBe(201);
    const { curatorId, state } = res.json();
    expect(curatorId).toMatch(/^[a-z0-9]{8}$/);
    expect(state).toBe("generating_palette"); // queued, not yet processed

    await roadie.drain();
    const asset = store.read(curatorId)!;
    expect(asset.metadata.name).toBe("Purple Rain");
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.palette!.colors).toHaveLength(2);
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
    const { app, store, roadie } = build();
    const { curatorId } = (
      await addAlbum(app, "Kind of Blue", "Miles Davis")
    ).json();
    await roadie.drain();

    const list = await app.inject({ method: "GET", url: "/api/albums" });
    expect(list.json().albums).toHaveLength(1);
    expect(list.json().albums[0]).toMatchObject({
      title: "Kind of Blue",
      source: "manual",
      state: "awaiting_review",
      paletteColors: 2,
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

describe("Roadie agent endpoints", () => {
  it("groups the queue by human-facing state", async () => {
    const { app, roadie } = build();
    await addAlbum(app, "Album One", "Artist");
    await addAlbum(app, "Album Two", "Artist");
    await roadie.drain();

    const queue = (
      await app.inject({ method: "GET", url: "/api/agent/queue" })
    ).json();
    expect(queue.awaiting_review).toHaveLength(2);
    expect(queue.errored).toHaveLength(0);
    expect(queue.done_recently).toHaveLength(0);
    expect(queue.awaiting_review[0]).toMatchObject({
      title: expect.any(String),
      state: "awaiting_review",
    });
  });

  it("reports status and supports pause/resume", async () => {
    const { app } = build();
    const status = (
      await app.inject({ method: "GET", url: "/api/agent/status" })
    ).json();
    expect(status).toMatchObject({ queueDepth: 0, paused: false });

    const paused = (
      await app.inject({ method: "POST", url: "/api/agent/pause" })
    ).json();
    expect(paused.paused).toBe(true);
    const resumed = (
      await app.inject({ method: "POST", url: "/api/agent/resume" })
    ).json();
    expect(resumed.paused).toBe(false);
  });

  it("retries a needs_manual album and 409s an album that isn't retryable", async () => {
    const { app, store, roadie } = buildWithSpotify();
    // Unknown id → 404 → needs_manual.
    const { curatorId } = (
      await app.inject({
        method: "POST",
        url: "/api/albums",
        payload: { spotifyId: "ghostghost" },
      })
    ).json();
    await roadie.drain();
    expect(store.read(curatorId)!.roadie.state).toBe("needs_manual");

    // Still 404 in the catalog, but the retry is accepted and re-runs the pipeline.
    const retry = await app.inject({
      method: "POST",
      url: `/api/agent/retry/${curatorId}`,
    });
    expect(retry.statusCode).toBe(200);
    await roadie.drain();
    expect(store.read(curatorId)!.roadie.state).toBe("needs_manual");

    // 404 for an unknown album; 409 for one that's already awaiting_review.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agent/retry/zzzzzzzz",
        })
      ).statusCode,
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
    const { app, store, roadie } = buildWithSpotify();
    const add = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyUri: "spotify:album:abc12345" },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({
      source: "spotify",
      state: "fetching_metadata",
    });
    const curatorId = add.json().curatorId;
    await roadie.drain();
    const asset = store.read(curatorId)!;
    expect(asset.metadata.source).toBe("spotify");
    expect(asset.roadie.state).toBe("awaiting_review");

    const dup = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyId: "abc12345" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().curatorId).toBe(curatorId);
  });

  it("a nonexistent album is accepted (201) then parked at needs_manual by Roadie", async () => {
    const { app, store, roadie } = buildWithSpotify();
    const res = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { spotifyId: "doesnotexist" },
    });
    expect(res.statusCode).toBe(201);
    await roadie.drain();
    expect(store.read(res.json().curatorId)!.roadie.state).toBe("needs_manual");
  });
});
