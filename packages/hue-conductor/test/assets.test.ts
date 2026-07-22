import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAlbumAssetReader, curatorIdFromUri } from "../src/assets.js";

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
  it("rejects non-curator / malformed URIs", () => {
    expect(curatorIdFromUri("spotify:album:abc")).toBeNull();
    expect(curatorIdFromUri("curator:album:TOOLONGGG")).toBeNull();
    expect(curatorIdFromUri("curator:album:UPPER123")).toBeNull();
    expect(curatorIdFromUri("")).toBeNull();
  });
});

describe("FsAlbumAssetReader", () => {
  it("reads a synced album by curatorId", () => {
    const reader = new FsAlbumAssetReader(seededDir());
    expect(reader.read(ID)).toMatchObject({
      metadata: { name: "Purple Rain", artist: "Prince" },
      pattern: { type: "static" },
    });
  });

  it("returns null for an album that isn't synced", () => {
    expect(new FsAlbumAssetReader(seededDir()).read("aaaa1111")).toBeNull();
  });

  it("returns null (not throw) on a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-assets-bad-"));
    writeFileSync(join(dir, `${ID}.json`), "{ not json");
    expect(new FsAlbumAssetReader(dir).read(ID)).toBeNull();
  });

  it("rejects an id that isn't the curatorId shape (path-traversal guard)", () => {
    const reader = new FsAlbumAssetReader(seededDir());
    expect(reader.read("../conductor")).toBeNull();
    expect(reader.read("2k7bxq9m/../x")).toBeNull();
  });
});
