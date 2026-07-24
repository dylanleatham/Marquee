import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import {
  fakeGenerate,
  fakeRoadie,
  fakeProber,
  buildMultipart,
} from "./helpers.js";

/** A server with one manual album drained to awaiting_review (palette generated, art on disk). */
async function reviewedServer() {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-palrt-")));
  const roadie = fakeRoadie(store);
  const { app } = buildServer({
    store,
    roadie,
    prober: fakeProber(),
    generate: fakeGenerate,
  });
  const mp = buildMultipart(
    { name: "Purple Rain", artist: "Prince" },
    {
      field: "artwork",
      filename: "a.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("IMG"),
    },
  );
  const add = await app.inject({
    method: "POST",
    url: "/api/albums",
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
  const { curatorId } = add.json();
  await roadie.drain();
  return { app, store, curatorId };
}

describe("palette routes", () => {
  it("PUT /palette saves a hand-edited palette", async () => {
    const { app, curatorId } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/palette`,
      payload: { colors: [{ hex: "#101010" }, { hex: "#f0f0f0" }] },
    });
    expect(res.statusCode).toBe(200);
    const { palette } = res.json();
    expect(palette.handEdited).toBe(true);
    expect(palette.colors.map((c: { hex: string }) => c.hex)).toEqual([
      "#101010",
      "#F0F0F0",
    ]);
  });

  it("PUT /palette 400s on a malformed hex", async () => {
    const { app, curatorId } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/palette`,
      payload: { colors: [{ hex: "not-a-color" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /palette 404s for an unknown album", async () => {
    const { app } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/zzzz9999/palette`,
      payload: { colors: [{ hex: "#101010" }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /palette/generate 409s over a hand-edit without force", async () => {
    const { app, curatorId } = await reviewedServer();
    await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/palette`,
      payload: { colors: [{ hex: "#101010" }, { hex: "#f0f0f0" }] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${curatorId}/palette/generate`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /palette/generate?force=1 re-extracts over a hand-edit", async () => {
    const { app, curatorId } = await reviewedServer();
    await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/palette`,
      payload: { colors: [{ hex: "#101010" }, { hex: "#f0f0f0" }] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${curatorId}/palette/generate?force=1`,
    });
    expect(res.statusCode).toBe(200);
    const { palette } = res.json();
    expect(palette.handEdited).toBe(false);
    expect(palette.colors).toHaveLength(2);
  });

  it("POST /palette/reset drops the hand-edit flag", async () => {
    const { app, curatorId } = await reviewedServer();
    await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/palette`,
      payload: { colors: [{ hex: "#101010" }, { hex: "#f0f0f0" }] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/albums/${curatorId}/palette/reset`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().palette.handEdited).toBe(false);
  });
});
