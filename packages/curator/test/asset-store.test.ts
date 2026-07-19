import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { makeAsset } from "./helpers.js";

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-store-")));

describe("AssetStore", () => {
  it("saves and reads an asset back", () => {
    const s = store();
    s.save(makeAsset("aaaa1111", "Purple Rain", "Prince"));
    expect(s.exists("aaaa1111")).toBe(true);
    expect(s.read("aaaa1111")?.metadata).toMatchObject({
      name: "Purple Rain",
      artist: "Prince",
    });
    expect(s.read("bbbb2222")).toBeNull();
  });

  it("keeps a .bak only on overwrite", () => {
    const s = store();
    const bak = s.paths.assetFile("aaaa1111") + ".bak";
    s.save(makeAsset("aaaa1111", "First"));
    expect(existsSync(bak)).toBe(false); // first write — nothing to back up
    s.save(makeAsset("aaaa1111", "Second"));
    expect(existsSync(bak)).toBe(true);
    expect(s.read("aaaa1111")?.metadata.name).toBe("Second");
  });

  it("lists newest-first and deletes", () => {
    const s = store();
    const older = makeAsset("aaaa1111", "Older");
    older.createdAt = "2026-01-01T00:00:00.000Z";
    const newer = makeAsset("bbbb2222", "Newer");
    newer.createdAt = "2026-06-01T00:00:00.000Z";
    s.save(older);
    s.save(newer);

    expect(s.list().map((a) => a.metadata.name)).toEqual(["Newer", "Older"]);

    expect(s.delete("aaaa1111")).toBe(true);
    expect(s.delete("aaaa1111")).toBe(false); // already gone
    expect(s.list().map((a) => a.curatorId)).toEqual(["bbbb2222"]);
  });

  it("update() applies to the latest on-disk state, not a stale copy (#38)", () => {
    const s = store();
    s.save(makeAsset("aaaa1111", "Original"));
    // Simulate a stale holder: something read the album earlier and still has that object.
    const stale = s.read("aaaa1111")!;
    // Meanwhile another writer changes the album on disk.
    s.save({
      ...s.read("aaaa1111")!,
      metadata: { ...stale.metadata, name: "Changed" },
    });
    // update() re-reads current state before applying its delta — the "Changed" name survives.
    const saved = s.update("aaaa1111", (a) => {
      a.cardArtCandidates = [
        { index: 0, fileId: "aaaa1111-c0", ext: "png", generatedAt: "x" },
      ];
    });
    expect(saved?.metadata.name).toBe("Changed");
    expect(s.read("aaaa1111")).toMatchObject({
      metadata: { name: "Changed" },
      cardArtCandidates: [{ index: 0 }],
    });
  });

  it("update() returns null if the album was deleted", () => {
    const s = store();
    expect(s.update("aaaa1111", () => {})).toBeNull();
  });

  it("refuses to save an invalid curatorId", () => {
    const s = store();
    const bad = makeAsset("aaaa1111");
    bad.curatorId = "NOPE";
    expect(() => s.save(bad)).toThrow(/invalid curatorId/i);
  });

  it("rejects path-traversal / malformed ids in read, exists, and delete", () => {
    const s = store();
    s.save(makeAsset("aaaa1111"));
    for (const evil of [
      "../../../../etc/passwd",
      "..",
      "AAAA1111",
      "a/b",
      "toolong12",
    ]) {
      expect(s.exists(evil)).toBe(false);
      expect(s.read(evil)).toBeNull();
      expect(s.delete(evil)).toBe(false); // must never rmSync outside the store
    }
    // the real album is untouched by all that
    expect(s.exists("aaaa1111")).toBe(true);
  });
});
