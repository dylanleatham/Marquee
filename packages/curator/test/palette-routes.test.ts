import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildFreshAsset } from "../src/albums/asset.js";
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

// ADR 0039: the per-album motion override. Route-level, alongside the palette routes it sits
// beside in the Look tab — the action's own behaviour is covered in palette-edit.test.ts.
describe("pattern-override route", () => {
  const put = (
    app: Awaited<ReturnType<typeof reviewedServer>>["app"],
    id: string,
    type: unknown,
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/albums/${id}/pattern-override`,
      payload: { type },
    });

  it("overrides an album and echoes the derived pattern back untouched", async () => {
    const { app, store, curatorId } = await reviewedServer();
    const before = store.read(curatorId)!.pattern;
    const res = await put(app, curatorId, "aurora");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ patternOverride: "aurora" });
    // The response carries the pattern precisely so a caller can see it survived.
    expect(res.json().pattern).toEqual(before);
    expect(store.read(curatorId)!.patternOverride).toBe("aurora");
  });

  it("accepts a CLIP pattern and still leaves the derived one alone (ADR 0039)", async () => {
    const { app, store, curatorId } = await reviewedServer();
    const before = store.read(curatorId)!.pattern;
    const res = await put(app, curatorId, "rotate");
    expect(res.statusCode).toBe(200);
    expect(res.json().patternOverride).toBe("rotate");
    expect(store.read(curatorId)!.pattern).toEqual(before);
  });

  it.each([
    "static",
    "rotate",
    "pulse",
    "crossfade",
    "aurora",
    "shimmer",
    "wave",
  ])("accepts %s", async (type) => {
    const { app, curatorId } = await reviewedServer();
    const res = await put(app, curatorId, type);
    expect(res.statusCode).toBe(200);
    expect(res.json().patternOverride).toBe(type);
  });

  it("clears the override with null", async () => {
    const { app, store, curatorId } = await reviewedServer();
    await put(app, curatorId, "shimmer");
    const res = await put(app, curatorId, null);
    expect(res.statusCode).toBe(200);
    expect(res.json().patternOverride).toBeNull();
    expect(store.read(curatorId)!.patternOverride).toBeUndefined();
  });

  it("treats a missing body as a clear rather than erroring", async () => {
    const { app, curatorId } = await reviewedServer();
    await put(app, curatorId, "wave");
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/pattern-override`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().patternOverride).toBeNull();
  });

  it("400s on a type that isn't a pattern at all", async () => {
    const { app, curatorId } = await reviewedServer();
    expect((await put(app, curatorId, "disco")).statusCode).toBe(400);
  });

  it("404s for an unknown album", async () => {
    const { app } = await reviewedServer();
    expect((await put(app, "zzzz9999", "aurora")).statusCode).toBe(404);
  });

  it("accepts params and returns them alongside the type (ADR 0036/0039)", async () => {
    const { app, store, curatorId } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/pattern-override`,
      payload: { type: "aurora", params: { speed: 0.2 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      patternOverride: "aurora",
      patternOverrideParams: { speed: 0.2 },
    });
    expect(store.read(curatorId)!.patternOverrideParams).toEqual({
      speed: 0.2,
    });
  });

  it("accepts a CLIP knob the same way", async () => {
    const { app, store, curatorId } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/pattern-override`,
      payload: { type: "rotate", params: { intervalMs: 900 } },
    });
    expect(res.statusCode).toBe(200);
    expect(store.read(curatorId)!.patternOverrideParams).toEqual({
      intervalMs: 900,
    });
  });

  it("400s on a knob outside its range or belonging to another pattern", async () => {
    const { app, curatorId } = await reviewedServer();
    const bad = (payload: unknown) =>
      app.inject({
        method: "PUT",
        url: `/api/albums/${curatorId}/pattern-override`,
        payload: payload as never,
      });
    expect(
      (await bad({ type: "aurora", params: { speed: 99 } })).statusCode,
    ).toBe(400);
    expect((await bad({ type: "wave", params: { scale: 2 } })).statusCode).toBe(
      400,
    );
    expect(
      (await bad({ type: "aurora", params: { speed: "fast" } })).statusCode,
    ).toBe(400);
    expect(
      (await bad({ type: "rotate", params: { intervalMs: 10 } })).statusCode,
    ).toBe(400);
    expect(
      (await bad({ type: "static", params: { intervalMs: 900 } })).statusCode,
    ).toBe(400);
  });

  it("no longer answers at the ADR 0035 route name", async () => {
    // ADR 0039 renames rather than aliases: a 404 is louder than an endpoint that quietly ignores
    // half the options the picker now offers.
    const { app, curatorId } = await reviewedServer();
    const res = await app.inject({
      method: "PUT",
      url: `/api/albums/${curatorId}/streaming-effect`,
      payload: { effect: "aurora" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s while Roadie is still processing the album", async () => {
    // Same rule as a palette edit (ADR 0025): the pipeline is still writing the asset. Asserted at
    // the route, not just the action, because the status code is the part a caller depends on.
    // Seeded directly rather than added-and-not-drained, so the album's state is the fixture.
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-strm-")));
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      generate: fakeGenerate,
    });
    store.save(
      buildFreshAsset({
        curatorId: "bbbb2222",
        metadata: { name: "N", artist: "A", source: "manual" },
        now: () => "2026-07-27T00:00:00.000Z",
      }),
    );
    expect((await put(app, "bbbb2222", "aurora")).statusCode).toBe(409);
  });
});
