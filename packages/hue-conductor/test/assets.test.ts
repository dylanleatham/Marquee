import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsAlbumAssetReader,
  FsAlbumAssetWriter,
  curatorIdFromUri,
} from "../src/assets.js";

const ID = "2k7bxq9m";
const album = {
  metadata: { name: "Purple Rain", artist: "Prince", year: 1984 },
  palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
  pattern: { type: "static", params: {} },
};

const seededDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-assets-"));
  writeFileSync(join(dir, `${ID}.json`), JSON.stringify(album));
  return dir;
};

describe("curatorIdFromUri", () => {
  it("extracts the id from a curator album URI", () => {
    expect(curatorIdFromUri(`curator:album:${ID}`)).toBe(ID);
  });
  it("extracts the id from a curator card URI (card == album for Conductor, ADR 0034)", () => {
    expect(curatorIdFromUri(`curator:card:${ID}`)).toBe(ID);
  });
  it("rejects non-curator / malformed URIs", () => {
    expect(curatorIdFromUri("spotify:album:abc")).toBeNull();
    expect(curatorIdFromUri("curator:disc:2k7bxq9m")).toBeNull();
    expect(curatorIdFromUri("curator:album:TOOLONGGG")).toBeNull();
    expect(curatorIdFromUri("curator:album:UPPER123")).toBeNull();
    expect(curatorIdFromUri("")).toBeNull();
  });
});

describe("FsAlbumAssetReader", () => {
  it("reads a synced album by curatorId", async () => {
    const reader = new FsAlbumAssetReader(seededDir());
    expect(await reader.read(ID)).toMatchObject({
      metadata: { name: "Purple Rain", artist: "Prince" },
      pattern: { type: "static" },
    });
  });

  it("returns null for an album that isn't synced", async () => {
    expect(
      await new FsAlbumAssetReader(seededDir()).read("aaaa1111"),
    ).toBeNull();
  });

  it("returns null (not throw) on a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-assets-bad-"));
    writeFileSync(join(dir, `${ID}.json`), "{ not json");
    expect(await new FsAlbumAssetReader(dir).read(ID)).toBeNull();
  });

  it("rejects an id that isn't the curatorId shape (path-traversal guard)", async () => {
    const reader = new FsAlbumAssetReader(seededDir());
    expect(await reader.read("../conductor")).toBeNull();
    expect(await reader.read("2k7bxq9m/../x")).toBeNull();
  });
});

describe("FsAlbumAssetWriter", () => {
  const emptyDir = () => mkdtempSync(join(tmpdir(), "conductor-assets-w-"));

  it("writes an asset the reader can then read back", async () => {
    const dir = emptyDir();
    const bytes = await new FsAlbumAssetWriter(dir).write(ID, album);
    expect(bytes).toBeGreaterThan(0);
    expect(await new FsAlbumAssetReader(dir).read(ID)).toMatchObject({
      metadata: { name: "Purple Rain" },
    });
  });

  it("creates the store directory on first push", async () => {
    const dir = join(emptyDir(), "not-yet");
    await new FsAlbumAssetWriter(dir).write(ID, album);
    expect(readdirSync(dir)).toEqual([`${ID}.json`]);
  });

  it("overwrites an existing asset rather than duplicating it", async () => {
    const dir = seededDir();
    const w = new FsAlbumAssetWriter(dir);
    await w.write(ID, { ...album, metadata: { name: "Sign o' the Times" } });
    expect(readdirSync(dir)).toEqual([`${ID}.json`]);
    expect(await new FsAlbumAssetReader(dir).read(ID)).toMatchObject({
      metadata: { name: "Sign o' the Times" },
    });
  });

  it("leaves no temp file behind — a scan mid-push must never see a partial", async () => {
    const dir = emptyDir();
    await new FsAlbumAssetWriter(dir).write(ID, album);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("rejects an id that isn't the curatorId shape (path-traversal guard)", async () => {
    const w = new FsAlbumAssetWriter(emptyDir());
    await expect(w.write("../escape", album)).rejects.toThrow(
      /not a curatorId/,
    );
    await expect(w.write("2k7bxq9m/../x", album)).rejects.toThrow(
      /not a curatorId/,
    );
  });

  it("surfaces a write failure instead of swallowing it (unlike the reader)", async () => {
    // A file where the directory should be: mkdir/writeFile cannot succeed under it.
    const base = emptyDir();
    const notADir = join(base, "wall");
    writeFileSync(notADir, "not a directory");
    await expect(
      new FsAlbumAssetWriter(notADir).write(ID, album),
    ).rejects.toThrow();
  });

  it("writes pretty-printed JSON so the store stays reviewable in git", async () => {
    const dir = emptyDir();
    await new FsAlbumAssetWriter(dir).write(ID, album);
    const raw = readFileSync(join(dir, `${ID}.json`), "utf8");
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  describe("list", () => {
    it("reports the curatorIds on disk, sorted", async () => {
      const dir = emptyDir();
      const w = new FsAlbumAssetWriter(dir);
      await w.write("zzzz1111", album);
      await w.write(ID, album);
      expect(await w.list()).toEqual([ID, "zzzz1111"]);
    });

    it("ignores anything that isn't a curatorId asset", async () => {
      const dir = seededDir();
      writeFileSync(join(dir, "notes.txt"), "hi");
      writeFileSync(join(dir, `${ID}.json.bak`), "{}");
      writeFileSync(join(dir, "TOOLONGGG.json"), "{}");
      expect(await new FsAlbumAssetWriter(dir).list()).toEqual([ID]);
    });

    it("reports an empty store rather than throwing when the dir is absent", async () => {
      const w = new FsAlbumAssetWriter(join(emptyDir(), "never-created"));
      expect(await w.list()).toEqual([]);
    });

    // "Nothing synced yet" and "the store is unreadable" must not look the same: Curator diffs this
    // list to report drift, so a swallowed fault would report every album as missing.
    it("surfaces a non-ENOENT fault instead of reporting an empty store", async () => {
      const base = emptyDir();
      const notADir = join(base, "wall");
      writeFileSync(notADir, "not a directory");
      await expect(new FsAlbumAssetWriter(notADir).list()).rejects.toThrow();
    });
  });
});
