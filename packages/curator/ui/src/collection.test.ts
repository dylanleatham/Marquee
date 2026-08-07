// How the collection arranges itself (ADR 0052): shuffled but stable, filtered, grouped with the
// empty groups dropped, and counted.
import { describe, it, expect } from "vitest";
import type { AlbumSummary } from "./api";
import {
  collectionCounts,
  DENSITIES,
  densityColumns,
  densityLabel,
  groupByNeed,
  matchesQuery,
  notCompleteDetail,
  seededShuffle,
  stuckTiles,
  visibleTiles,
} from "./collection";

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
    state: "awaiting_review",
    artwork: null,
    paletteColors: 3,
    hasVideo: false,
    year: 1977,
    genres: ["rock"],
    paletteHexes: ["#111111", "#222222"],
    hasCardArt: false,
    tagsWritten: false,
    previewApprovedAt: null,
    physicallyVerifiedAt: null,
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const done = {
  state: "verified" as const,
  hasVideo: true,
  hasCardArt: true,
  tagsWritten: true,
  previewApprovedAt: "2026-08-01T10:00:00.000Z",
  physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
};

const LIBRARY: AlbumSummary[] = [
  album({ curatorId: "a", title: "Purple Rain", artist: "Prince" }), // needs a look
  album({
    curatorId: "b",
    title: "Aja",
    artist: "Steely Dan",
    ...done,
    hasVideo: false,
  }), // needs visualizer
  album({
    curatorId: "c",
    title: "Kind of Blue",
    artist: "Miles Davis",
    state: "downloading_art",
  }), // Roadie
  album({ curatorId: "d", title: "Blue", artist: "Joni Mitchell", ...done }), // ready
  album({
    curatorId: "e",
    title: "Rachel's Greatest Hits",
    artist: "?",
    state: "errored",
    lastError: { message: "no", reason: "spotify_lookup_failed" },
  }), // stuck
];

describe("seededShuffle", () => {
  it("is stable for one seed and different for another", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(seededShuffle(items, 0.42)).toEqual(seededShuffle(items, 0.42));
    // Not a guarantee for every pair of seeds, but these two genuinely differ — the point is that
    // reseeding reorders rather than being a no-op.
    expect(seededShuffle(items, 0.42)).not.toEqual(seededShuffle(items, 0.91));
  });

  it("keeps every record — a shuffle never drops one", () => {
    const items = LIBRARY.map((a) => a.curatorId);
    expect([...seededShuffle(items, 0.7)].sort()).toEqual([...items].sort());
  });

  it("survives a seed of zero rather than degenerating", () => {
    expect(seededShuffle(["a", "b", "c"], 0)).toHaveLength(3);
  });
});

describe("filtering", () => {
  it("matches title or artist, case-insensitively", () => {
    const a = album({ curatorId: "x", title: "Purple Rain", artist: "Prince" });
    expect(matchesQuery(a, "purple")).toBe(true);
    expect(matchesQuery(a, "PRINCE")).toBe(true);
    expect(matchesQuery(a, "  ")).toBe(true);
    expect(matchesQuery(a, "miles")).toBe(false);
  });

  it("shows everything, including the ones Roadie holds and the stuck one", () => {
    const tiles = visibleTiles(LIBRARY, { filter: "all", query: "", seed: 1 });
    expect(tiles).toHaveLength(5);
  });

  it("excludes Roadie's and the stuck one from both work filters", () => {
    // Neither "not complete" nor "ready" is true of a record Roadie is still holding, and a tile
    // that offers nothing to do is a dead end in a list you are working down.
    const needs = visibleTiles(LIBRARY, {
      filter: "needs",
      query: "",
      seed: 1,
    });
    expect(needs.map((t) => t.album.curatorId).sort()).toEqual(["a", "b"]);
    const ready = visibleTiles(LIBRARY, {
      filter: "ready",
      query: "",
      seed: 1,
    });
    expect(ready.map((t) => t.album.curatorId)).toEqual(["d"]);
  });

  it("applies the query on top of the filter", () => {
    const tiles = visibleTiles(LIBRARY, {
      filter: "all",
      query: "miles",
      seed: 1,
    });
    expect(tiles.map((t) => t.album.title)).toEqual(["Kind of Blue"]);
  });
});

describe("grouping", () => {
  const tiles = visibleTiles(LIBRARY, { filter: "needs", query: "", seed: 3 });

  it("groups under the same labels the tiles use", () => {
    expect(groupByNeed(tiles).map((g) => g.label)).toEqual([
      "NEEDS A LOOK",
      "NEEDS VISUALIZER",
    ]);
  });

  it("does not render an empty group at all", () => {
    // Needs Card and Needs Sign-off have nothing in them today, so they aren't drawn — a heading
    // with nothing under it reads as a category you failed to clear.
    const labels = groupByNeed(tiles).map((g) => g.label);
    expect(labels).not.toContain("NEEDS CARD");
    expect(labels).not.toContain("NEEDS SIGN-OFF");
  });

  it("keeps the stuck record out of the groups and in its own row", () => {
    const all = visibleTiles(LIBRARY, { filter: "all", query: "", seed: 3 });
    expect(groupByNeed(all).flatMap((g) => g.tiles)).not.toContainEqual(
      expect.objectContaining({
        album: expect.objectContaining({ curatorId: "e" }),
      }),
    );
    expect(stuckTiles(all).map((t) => t.album.curatorId)).toEqual(["e"]);
  });
});

describe("counts", () => {
  it("counts not-complete, ready, not-started and stuck as four separate things", () => {
    expect(collectionCounts(LIBRARY)).toMatchObject({
      total: 5,
      notComplete: 2,
      ready: 1,
      notStarted: 1,
      stuck: 1,
    });
  });

  it("attributes each record to its first outstanding need only", () => {
    // "a" is missing all four; it counts once, under lights.
    expect(collectionCounts(LIBRARY).byNeed).toEqual({
      lights: 1,
      visualizer: 1,
      card: 0,
      tags: 0,
    });
  });

  it("spells the detail line as a sentence, and agrees with itself", () => {
    expect(notCompleteDetail(collectionCounts(LIBRARY))).toBe(
      "one still needs a look",
    );
    expect(
      notCompleteDetail(
        collectionCounts([
          ...LIBRARY,
          album({ curatorId: "f", title: "Rumours", artist: "Fleetwood Mac" }),
          album({ curatorId: "g", title: "Voodoo", artist: "D'Angelo" }),
        ]),
      ),
    ).toBe("three still need a look");
    expect(
      notCompleteDetail(
        collectionCounts(LIBRARY.filter((a) => a.curatorId === "d")),
      ),
    ).toBe("nothing outstanding");
  });
});

describe("density", () => {
  it("cycles 5 → 7 → 9 → 5 and labels itself without a number", () => {
    expect([0, 1, 2, 3].map((i) => densityColumns(i))).toEqual([5, 7, 9, 5]);
    expect(densityLabel(0)).toBe("DENSITY ▪▫▫");
    expect(densityLabel(3)).toBe("DENSITY ▪▫▫");
  });

  it("survives whatever comes back out of the URL", () => {
    // `?density=banana` is one refresh away at all times, and `repeat(undefined, …)` is a blank
    // screen rather than a wrong one.
    for (const junk of [NaN, -1, 99, 1.7]) {
      expect(DENSITIES).toContain(densityColumns(junk));
      expect(densityLabel(junk)).toMatch(/^DENSITY /);
    }
  });
});
