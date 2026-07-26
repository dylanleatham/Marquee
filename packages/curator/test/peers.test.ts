// "Next album at this state" (issue #94). The property that matters is that a peer walk and the
// queue agree — the whole affordance is "keep going down the list I was just looking at", and a
// second ordering that drifted from the queue's would send you somewhere you didn't expect.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { bucketFor, peerContext } from "../src/albums/peers.js";
import type { AlbumAsset, RoadieState } from "../src/albums/asset.js";
import { fakeRoadie, fakeProber, fakeGenerate, makeAsset } from "./helpers.js";

const at = (curatorId: string, state: RoadieState, name = curatorId) => {
  const a = makeAsset(curatorId, name, "Artist");
  a.roadie.state = state;
  return a;
};

const store = (assets: AlbumAsset[]) => {
  const s = new AssetStore(mkdtempSync(join(tmpdir(), "curator-peer-")));
  for (const a of assets) s.save(a);
  return s;
};

describe("bucketFor", () => {
  it("maps the named states to themselves", () => {
    expect(bucketFor("awaiting_review")).toBe("awaiting_review");
    expect(bucketFor("awaiting_tag_write")).toBe("awaiting_tag_write");
    expect(bucketFor("errored")).toBe("errored");
  });

  it("reads verified as done-recently, and every in-flight state as processing", () => {
    expect(bucketFor("verified")).toBe("done_recently");
    for (const s of [
      "fresh",
      "fetching_metadata",
      "downloading_art",
      "generating_palette",
      "drafting_prompts",
    ] as RoadieState[])
      expect(bucketFor(s)).toBe("processing");
  });
});

describe("peerContext", () => {
  const albums = [
    at("aaaaaaa1", "awaiting_review"),
    at("bbbbbbb2", "awaiting_video"),
    at("ccccccc3", "awaiting_review"),
    at("ddddddd4", "awaiting_review"),
  ];

  it("places an album among only its own state's peers", () => {
    const ctx = peerContext(albums, "ccccccc3")!;
    expect(ctx.bucket).toBe("awaiting_review");
    // The album awaiting video sits between them in the raw list and must not be a neighbour.
    expect(ctx.position).toBe(2);
    expect(ctx.total).toBe(3);
    expect(ctx.prev?.curatorId).toBe("aaaaaaa1");
    expect(ctx.next?.curatorId).toBe("ddddddd4");
  });

  /**
   * Not wrapping is the deliberate part. At the end of a run of tag writes the honest answer is
   * "that was the last one"; looping silently back to the first would have you re-verify an album
   * you already finished without noticing.
   */
  it("stops at both ends rather than wrapping", () => {
    expect(peerContext(albums, "aaaaaaa1")!.prev).toBeNull();
    expect(peerContext(albums, "ddddddd4")!.next).toBeNull();
  });

  it("reports an album that is alone at its state, rather than pretending", () => {
    const ctx = peerContext(albums, "bbbbbbb2")!;
    expect(ctx).toMatchObject({
      position: 1,
      total: 1,
      prev: null,
      next: null,
    });
  });

  it("carries a title so a neighbour can be named, falling back to the id", () => {
    const named = [
      at("aaaaaaa1", "awaiting_review", "Kind of Blue"),
      at("bbbbbbb2", "awaiting_review", ""),
    ];
    expect(peerContext(named, "aaaaaaa1")!.next).toEqual({
      curatorId: "bbbbbbb2",
      title: "bbbbbbb2", // an album still fetching its metadata is still navigable
    });
  });

  it("returns null for an album that isn't there", () => {
    expect(peerContext(albums, "nosuchid")).toBeNull();
  });
});

describe("GET /api/albums/:curatorId/peers", () => {
  /** A server whose Roadie has finished with everything, so states are stable while we assert. */
  const app = async (assets: AlbumAsset[]) => {
    const s = store(assets);
    const roadie = fakeRoadie(s);
    const { app } = buildServer({
      store: s,
      roadie,
      prober: fakeProber(),
      generate: fakeGenerate,
    });
    await roadie.drain(); // buildServer recovers mid-processing albums; let that settle first
    return app;
  };

  it("answers with the album's place in its bucket", async () => {
    const server = await app([
      at("aaaaaaa1", "awaiting_tag_write"),
      at("bbbbbbb2", "awaiting_tag_write"),
    ]);
    const res = await server.inject({ url: "/api/albums/aaaaaaa1/peers" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      bucket: "awaiting_tag_write",
      position: 1,
      total: 2,
      prev: null,
      next: { curatorId: "bbbbbbb2" },
    });
  });

  it("agrees with the queue about who sits together and in what order", async () => {
    // The guarantee worth pinning: both read the same bucketing, so walking peers can't send you
    // somewhere the list you were looking at wouldn't.
    const ids = ["aaaaaaa1", "bbbbbbb2", "ccccccc3", "ddddddd4"];
    const server = await app([
      at("aaaaaaa1", "awaiting_review"),
      at("bbbbbbb2", "verified"),
      at("ccccccc3", "awaiting_review"),
      at("ddddddd4", "needs_manual"),
    ]);
    const queue = (
      await server.inject({ url: "/api/agent/queue" })
    ).json() as Record<string, { curatorId: string }[]>;
    const bucketInQueue = (id: string) =>
      Object.entries(queue).find(([, rows]) =>
        rows.some((r) => r.curatorId === id),
      )?.[0];

    // Assert the agreement itself rather than the buckets by name: the point is that neither
    // endpoint can send you somewhere the other wouldn't, whatever the states happen to be.
    for (const id of ids) {
      const peers = (
        await server.inject({ url: `/api/albums/${id}/peers` })
      ).json();
      expect(peers.bucket).toBe(bucketInQueue(id));
      expect(peers.total).toBe(queue[peers.bucket]!.length);
      expect(peers.next?.curatorId ?? null).toBe(
        queue[peers.bucket]![peers.position]?.curatorId ?? null,
      );
    }
  });

  it("404s for an unknown album", async () => {
    const res = await (
      await app([])
    ).inject({
      url: "/api/albums/nosuchid/peers",
    });
    expect(res.statusCode).toBe(404);
  });
});
