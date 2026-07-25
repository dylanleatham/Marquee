// Artwork override (issue #100 / curator-spec milestone 15). The properties that matter: the
// override wins *everywhere* the cover is read, removing it reverts rather than re-downloads, and a
// hand-edited palette is never destroyed without the user saying so (curator-spec §12).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import {
  resolvedArtworkFile,
  applyArtworkOverride,
  removeArtworkOverride,
} from "../src/albums/artwork.js";
import {
  fakeRoadie,
  fakeProber,
  fakeGenerate,
  makeAsset,
  pngBytes,
  jpegBytes,
  buildMultipart,
} from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-ovr-")));

/** Seed an album with a fetched cover already on disk. */
const seed = (s: AssetStore, id = "ovr00001") => {
  s.save(makeAsset(id));
  mkdirSync(s.paths.artwork, { recursive: true });
  writeFileSync(s.paths.artworkFile(id), jpegBytes());
  return id;
};

const curator = (s: AssetStore) =>
  buildServer({
    store: s,
    roadie: fakeRoadie(s),
    prober: fakeProber(),
    generate: fakeGenerate,
  }).app;

const upload = (
  app: ReturnType<typeof curator>,
  id: string,
  data: Buffer,
  fields: Record<string, string> = {},
) => {
  const mp = buildMultipart(fields, {
    field: "file",
    filename: "better-scan.png",
    contentType: "image/png",
    data,
  });
  return app.inject({
    method: "POST",
    url: `/api/albums/${id}/artwork/override`,
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
};

describe("artwork override — resolution", () => {
  let s: AssetStore;
  beforeEach(() => {
    s = store();
  });

  it("resolves to the fetched cover when no override is active", () => {
    const id = seed(s);
    expect(resolvedArtworkFile(s, s.read(id)!)).toBe(s.paths.artworkFile(id));
  });

  // The whole point of the module: every reader of the cover must see the override, not just the
  // one that happened to remember to check.
  it("resolves to the override once one is applied", () => {
    const id = seed(s);
    applyArtworkOverride(s, id, pngBytes());
    const resolved = resolvedArtworkFile(s, s.read(id)!);
    expect(resolved).toBe(s.paths.artworkOverrideFile(id, "png"));
    expect(existsSync(resolved)).toBe(true);
  });

  it("records the override on the asset and raises the Roadie flag", () => {
    const id = seed(s);
    const asset = applyArtworkOverride(s, id, pngBytes());
    expect(asset.artwork!.overrideActive).toBe(true);
    expect(asset.artwork!.resolvedPath).toContain("artwork-overrides");
    expect(asset.artwork!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(asset.roadie.flags.art_override_active).toBe(true);
  });

  it("replaces an override of a different format without stranding the old file", () => {
    const id = seed(s);
    applyArtworkOverride(s, id, pngBytes());
    applyArtworkOverride(s, id, jpegBytes());
    expect(existsSync(s.paths.artworkOverrideFile(id, "png"))).toBe(false);
    expect(existsSync(s.paths.artworkOverrideFile(id, "jpg"))).toBe(true);
  });

  it("rejects a file that isn't a PNG or JPEG", () => {
    const id = seed(s);
    expect(() =>
      applyArtworkOverride(s, id, Buffer.from("not an image")),
    ).toThrow(/PNG or JPEG/);
  });

  it("reverts to the fetched cover on removal, and deletes the override file", () => {
    const id = seed(s);
    applyArtworkOverride(s, id, pngBytes());
    const asset = removeArtworkOverride(s, id)!;

    expect(asset.artwork!.overrideActive).toBe(false);
    expect(asset.roadie.flags.art_override_active).toBe(false);
    expect(resolvedArtworkFile(s, asset)).toBe(s.paths.artworkFile(id));
    expect(existsSync(s.paths.artworkOverrideFile(id, "png"))).toBe(false);
    // Reverting must not re-download: the fetched cover was there all along.
    expect(existsSync(s.paths.artworkFile(id))).toBe(true);
  });

  it("leaves a manual album with no artwork at all when there was no fetched cover", () => {
    const s2 = store();
    s2.save(makeAsset("ovr00002"));
    applyArtworkOverride(s2, "ovr00002", pngBytes());
    const asset = removeArtworkOverride(s2, "ovr00002")!;
    expect(asset.artwork).toBeUndefined();
  });

  it("returns null when there is no override to remove", () => {
    const id = seed(s);
    expect(removeArtworkOverride(s, id)).toBeNull();
  });
});

describe("artwork override — routes", () => {
  let s: AssetStore;
  beforeEach(() => {
    s = store();
  });

  it("uploads an override and regenerates the palette by default", async () => {
    const id = seed(s);
    const res = await upload(curator(s), id, pngBytes());

    expect(res.statusCode).toBe(201);
    expect(res.json().paletteRegenerated).toBe(true);
    expect(s.read(id)!.artwork!.overrideActive).toBe(true);
  });

  // curator-spec §12: "never overwrite a hand-edit without user action."
  it("keeps a hand-edited palette by default rather than silently discarding it", async () => {
    const id = seed(s);
    const a = s.read(id)!;
    a.palette = { ...a.palette!, handEdited: true, colors: a.palette!.colors };
    s.save(a);

    const res = await upload(curator(s), id, pngBytes());

    expect(res.statusCode).toBe(201);
    expect(res.json().paletteRegenerated).toBe(false);
    expect(s.read(id)!.palette!.handEdited).toBe(true);
    // The art still changed — only the palette decision was deferred to the user.
    expect(s.read(id)!.artwork!.overrideActive).toBe(true);
  });

  it("regenerates over a hand-edit when the user explicitly says so", async () => {
    const id = seed(s);
    const a = s.read(id)!;
    a.palette = { ...a.palette!, handEdited: true };
    s.save(a);

    const res = await upload(curator(s), id, pngBytes(), {
      regeneratePalette: "true",
    });

    expect(res.json().paletteRegenerated).toBe(true);
    expect(s.read(id)!.palette!.handEdited).toBe(false);
  });

  it("serves the override from the artwork route, with its own content type", async () => {
    const id = seed(s);
    const app = curator(s);
    await upload(app, id, pngBytes());

    const res = await app.inject({
      method: "GET",
      url: `/api/albums/${id}/artwork`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("removes the override and re-derives the palette from the fetched cover", async () => {
    const id = seed(s);
    const app = curator(s);
    await upload(app, id, pngBytes());

    const res = await app.inject({
      method: "DELETE",
      url: `/api/albums/${id}/artwork/override`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().paletteRegenerated).toBe(true);
    expect(s.read(id)!.artwork!.overrideActive).toBe(false);
  });

  it("404s removing an override that isn't there, and on an unknown album", async () => {
    const id = seed(s);
    const app = curator(s);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/albums/${id}/artwork/override`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await upload(app, "missing0", pngBytes())).statusCode).toBe(404);
  });

  it("400s an upload with no file", async () => {
    const id = seed(s);
    const mp = buildMultipart({ regeneratePalette: "false" });
    const res = await curator(s).inject({
      method: "POST",
      url: `/api/albums/${id}/artwork/override`,
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(400);
  });
});
