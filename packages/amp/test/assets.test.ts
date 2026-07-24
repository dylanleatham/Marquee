import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAlbumAssetReader } from "../src/assets.js";

const ID = "2k7bxq9m";

function seededDir(asset: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "amp-assets-"));
  writeFileSync(join(dir, `${ID}.json`), JSON.stringify(asset));
  return dir;
}

describe("FsAlbumAssetReader", () => {
  it("reads a synced album's Spotify slice by curatorId", async () => {
    const dir = seededDir({
      metadata: { name: "X", artist: "Y", spotifyUri: "spotify:album:abc" },
      // extra fields Amp ignores are fine — it reads a structural superset
      palette: { colors: [] },
    });
    expect(await new FsAlbumAssetReader(dir).read(ID)).toMatchObject({
      metadata: { spotifyUri: "spotify:album:abc" },
    });
  });

  it("returns null for an album that isn't synced", async () => {
    const dir = seededDir({ metadata: { name: "X", artist: "Y" } });
    expect(await new FsAlbumAssetReader(dir).read("aaaa1111")).toBeNull();
  });

  it("returns null (not throw) on a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amp-assets-bad-"));
    writeFileSync(join(dir, `${ID}.json`), "{ not json");
    expect(await new FsAlbumAssetReader(dir).read(ID)).toBeNull();
  });

  it("rejects an id that isn't the curatorId shape (path-traversal guard)", async () => {
    const dir = seededDir({ metadata: { name: "X", artist: "Y" } });
    expect(await new FsAlbumAssetReader(dir).read("../amp")).toBeNull();
    expect(await new FsAlbumAssetReader(dir).read("2k7bxq9m/../x")).toBeNull();
  });
});
