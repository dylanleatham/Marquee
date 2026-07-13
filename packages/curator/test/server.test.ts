import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeGenerate, buildMultipart } from "./helpers.js";

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

  it("rejects a POST with no artwork file (400) and a non-multipart POST (415)", async () => {
    const { app } = build();
    const noFile = buildMultipart({ name: "X", artist: "Y" });
    const r400 = await app.inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": noFile.contentType },
      payload: noFile.body,
    });
    expect(r400.statusCode).toBe(400);

    const r415 = await app.inject({
      method: "POST",
      url: "/api/albums",
      payload: { name: "x" },
    });
    expect(r415.statusCode).toBe(415);
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
