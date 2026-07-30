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

  // ADR 0039 renamed streamingEffect/streamingParams → patternOverride/patternOverrideParams. An
  // album last saved under the old names must keep playing what its owner chose, so the rename is
  // applied on read and the old keys are dropped — two answers that could disagree is worse than one.
  describe("ADR 0039 field migration", () => {
    const legacy = (id: string, extra: Record<string, unknown>) => {
      const s = store();
      const a = makeAsset(id) as Record<string, unknown>;
      delete a.patternOverride;
      Object.assign(a, extra);
      s.save(a as never);
      return s;
    };

    it("reads a pre-rename opt-in under the new names", () => {
      const s = legacy("aaaa1111", {
        streamingEffect: "aurora",
        streamingParams: { speed: 0.2 },
      });
      const read = s.read("aaaa1111")!;
      expect(read.patternOverride).toBe("aurora");
      expect(read.patternOverrideParams).toEqual({ speed: 0.2 });
      expect(read.streamingEffect).toBeUndefined();
      expect(read.streamingParams).toBeUndefined();
    });

    it("migrates through list() too, not only read()", () => {
      const s = legacy("aaaa1111", { streamingEffect: "wave" });
      expect(s.list()[0]!.patternOverride).toBe("wave");
    });

    it("leaves an album that never opted in with no override at all", () => {
      const s = legacy("aaaa1111", { streamingEffect: null });
      const read = s.read("aaaa1111")!;
      expect(read.patternOverride).toBeUndefined();
      expect(read.streamingEffect).toBeUndefined();
    });

    it("prefers the new field when an asset somehow carries both", () => {
      const s = legacy("aaaa1111", {
        patternOverride: "rotate",
        streamingEffect: "aurora",
      });
      expect(s.read("aaaa1111")!.patternOverride).toBe("rotate");
    });

    it("persists the new names on the next save", () => {
      const s = legacy("aaaa1111", { streamingEffect: "shimmer" });
      s.save(s.read("aaaa1111")!);
      const raw = s.read("aaaa1111") as Record<string, unknown>;
      expect(raw.patternOverride).toBe("shimmer");
      expect("streamingEffect" in raw).toBe(false);
    });
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
