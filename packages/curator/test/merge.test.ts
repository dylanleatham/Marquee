// Merging one copy of a record into another (issue #279). The interesting behaviour is the
// refusals — this decides when *not* to touch someone's collection.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { planMerge } from "../src/albums/merge.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";
import type { AlbumAsset } from "../src/albums/asset.js";

const withDiscogs = (id: string, releaseId = 12345): AlbumAsset => {
  const a = makeAsset(id, "In Rainbows", "Radiohead");
  a.metadata.source = "discogs";
  a.metadata.discogsUri = `discogs:release:${releaseId}`;
  a.metadata.discogsReleaseId = releaseId;
  return a;
};

const withVisualizer = (id: string): AlbumAsset => {
  const a = makeAsset(id, "In Rainbows", "Radiohead");
  a.metadata.source = "spotify";
  a.visualizer = {
    fileId: id,
    originalFilename: "clip.mp4",
    durationSec: 110,
    loopStrategy: "loop",
    attachedAt: "2026-07-11T00:00:00.000Z",
  };
  return a;
};

describe("planMerge", () => {
  it("moves the Discogs identity onto the survivor — the whole point", () => {
    // Delete the copy holding the release id without moving it first and the next sweep, seeing an
    // unmatched release, adds it straight back. The cleanup would quietly undo itself.
    const plan = planMerge(withVisualizer("keep0001"), withDiscogs("drop0001"));

    expect(plan.blockers).toEqual([]);
    expect(plan.adopt).toEqual({
      discogsUri: "discogs:release:12345",
      discogsReleaseId: 12345,
    });
  });

  it("never overwrites what the survivor already has", () => {
    // The owner chose this copy because its metadata is the one they trust.
    const survivor = withDiscogs("keep0002", 999);
    const plan = planMerge(survivor, withDiscogs("drop0002", 999));

    expect(plan.adopt).toEqual({});
  });

  it("refuses when the copy being dropped holds the only visualizer", () => {
    // Minutes of generation and hundreds of megabytes that nothing else can reconstruct.
    const plan = planMerge(makeAsset("bare0001"), withVisualizer("vid00001"));

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatch(/only visualizer/);
  });

  it("refuses two different Discogs releases — that is two records, not one twice", () => {
    const plan = planMerge(
      withDiscogs("keep0003", 111),
      withDiscogs("drop0003", 222),
    );

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatch(/different releases/);
  });

  it("refuses to merge an album into itself", () => {
    const a = withDiscogs("same0001");
    expect(planMerge(a, a).blockers[0]).toMatch(/into itself/);
  });
});

describe("POST /api/albums/:curatorId/merge", () => {
  let store: AssetStore;
  const app = () =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { conductor: { url: "http://127.0.0.1:1" } },
    }).app;

  beforeEach(() => {
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-merge-")));
  });

  it("adopts the identity and removes the twin, in that order", async () => {
    store.save(withVisualizer("keep0001"));
    store.save(withDiscogs("drop0001"));

    const res = await app().inject({
      method: "POST",
      url: "/api/albums/keep0001/merge",
      payload: { from: "drop0001" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merged: "keep0001",
      removed: "drop0001",
      adopted: { discogsUri: "discogs:release:12345" },
    });
    // The survivor can now be matched by a future sweep, which is what stops it coming back.
    expect(store.read("keep0001")!.metadata.discogsUri).toBe(
      "discogs:release:12345",
    );
    expect(store.read("drop0001")).toBeNull();
    // And its visualizer is untouched.
    expect(store.read("keep0001")!.visualizer).toBeTruthy();
  });

  it("changes nothing when it refuses", async () => {
    store.save(makeAsset("bare0001"));
    store.save(withVisualizer("vid00001"));

    const res = await app().inject({
      method: "POST",
      url: "/api/albums/bare0001/merge",
      payload: { from: "vid00001" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().blockers[0]).toMatch(/only visualizer/);
    // Both still there: a refused merge is not a partial merge.
    expect(store.read("bare0001")).toBeTruthy();
    expect(store.read("vid00001")).toBeTruthy();
  });

  it("404s when either side is missing", async () => {
    store.save(withVisualizer("keep0001"));

    expect(
      (
        await app().inject({
          method: "POST",
          url: "/api/albums/keep0001/merge",
          payload: { from: "nosuch01" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app().inject({
          method: "POST",
          url: "/api/albums/nosuch01/merge",
          payload: { from: "keep0001" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("400s without a `from`", async () => {
    store.save(withVisualizer("keep0001"));
    const res = await app().inject({
      method: "POST",
      url: "/api/albums/keep0001/merge",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
