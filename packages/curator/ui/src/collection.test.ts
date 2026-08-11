// How the collection arranges itself (ADR 0052): shuffled but stable, filtered, grouped with the
// empty groups dropped, and counted.
import { describe, it, expect } from "vitest";
import type { AlbumSummary } from "./api";
import {
  collectionCounts,
  DENSITIES,
  densityColumns,
  densityLabel,
  filterChips,
  groupByNeed,
  matchesQuery,
  notCompleteDetail,
  onlyNeedFilter,
  parseFilter,
  seededShuffle,
  stuckTiles,
  visibleTiles,
  type CollectionFilter,
} from "./collection";
import { NEED_ORDER, stateLabel } from "./needs";

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
  album({ curatorId: "a", title: "Purple Rain", artist: "Prince" }), // owes all three
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

  it("gives the records Roadie holds and the failed ones a chip each", () => {
    // They are excluded from every work filter, so without their own chips they'd be reachable
    // only through EVERYTHING.
    const ids = (filter: CollectionFilter) =>
      visibleTiles(LIBRARY, { filter, query: "", seed: 1 }).map(
        (t) => t.album.curatorId,
      );
    expect(ids("roadie")).toEqual(["c"]);
    expect(ids("stuck")).toEqual(["e"]);
  });
});

/**
 * The per-need chips (ADR 0070) ask "does this record still owe a card?", not "is a card the first
 * thing it owes?" — so one record can answer to several chips. That is the whole point: the needs
 * are independent and may be done in any order, and first-need semantics would have hidden a record
 * wanting a card behind the visualizer it also wanted.
 */
describe("filtering by one need", () => {
  const OWES: AlbumSummary[] = [
    // Owes a visualizer and a card, and is first-need visualizer.
    album({ curatorId: "both", ...done, hasVideo: false, hasCardArt: false }),
    album({ curatorId: "cardOnly", ...done, hasCardArt: false }),
    album({
      curatorId: "tagsOnly",
      ...done,
      tagsWritten: false,
      state: "awaiting_verify",
      physicallyVerifiedAt: null,
    }),
    album({ curatorId: "fine", ...done }),
  ];
  const ids = (filter: CollectionFilter) =>
    visibleTiles(OWES, { filter, query: "", seed: 1 })
      .map((t) => t.album.curatorId)
      .sort();

  it("shows a record under every need it still owes, not just its first", () => {
    expect(ids("visualizer")).toEqual(["both"]);
    expect(ids("card")).toEqual(["both", "cardOnly"]);
    expect(ids("tags")).toEqual(["tagsOnly"]);
  });

  it("relabels the tile to the need you asked for", () => {
    // "both" is first-need visualizer. Under NEEDS CARD a tile reading NEEDS VISUALIZER would look
    // like the filter had leaked.
    const [tile] = visibleTiles(OWES, {
      filter: "card",
      query: "",
      seed: 1,
    }).filter((t) => t.album.curatorId === "both");
    expect(tile!.state).toEqual({ kind: "needs", need: "card" });
    expect(stateLabel(tile!.state)).toBe("NEEDS CARD");
  });

  it("leaves the tile's own label alone under every other filter", () => {
    const [tile] = visibleTiles(OWES, {
      filter: "needs",
      query: "",
      seed: 1,
    }).filter((t) => t.album.curatorId === "both");
    expect(tile!.state).toEqual({ kind: "needs", need: "visualizer" });
  });

  it("still answers to the search", () => {
    const named = album({
      curatorId: "z",
      title: "Rumours",
      ...done,
      hasCardArt: false,
    });
    expect(
      visibleTiles([...OWES, named], {
        filter: "card",
        query: "rumours",
        seed: 1,
      }).map((t) => t.album.curatorId),
    ).toEqual(["z"]);
  });

  it("never offers a need on a record you cannot act on", () => {
    // A stuck record has no card either, but making one is not the thing to do about it.
    const stuck = album({
      curatorId: "broken",
      state: "errored",
      lastError: { message: "no", reason: "spotify_lookup_failed" },
    });
    const held = album({ curatorId: "held", state: "downloading_art" });
    expect(
      visibleTiles([...OWES, stuck, held], {
        filter: "card",
        query: "",
        seed: 1,
      }).map((t) => t.album.curatorId),
    ).not.toContain("broken");
    expect(
      visibleTiles([...OWES, stuck, held], {
        filter: "card",
        query: "",
        seed: 1,
      }).map((t) => t.album.curatorId),
    ).not.toContain("held");
  });
});

describe("the chips", () => {
  it("names one per state, plus one per need, in working order", () => {
    expect(filterChips(collectionCounts(LIBRARY))).toEqual([
      { value: "all", label: "EVERYTHING", count: null },
      { value: "needs", label: "NOT COMPLETE", count: 2 },
      { value: "visualizer", label: "NEEDS VISUALIZER", count: 2 },
      { value: "card", label: "NEEDS CARD", count: 1 },
      { value: "tags", label: "NEEDS SIGN-OFF", count: 1 },
      { value: "only-visualizer", label: "JUST NEEDS VISUALIZER", count: 1 },
      { value: "ready", label: "READY", count: 1 },
      { value: "roadie", label: "NOT STARTED", count: 1 },
      { value: "stuck", label: "STUCK", count: 1 },
    ]);
  });

  it("drops the transient chips at zero and keeps the standing ones", () => {
    // ADR 0071. STUCK, NOT STARTED and each JUST NEEDS … name a passing condition, so at zero they
    // offer a room with nothing in it. NOT COMPLETE, READY and the plain need chips are the
    // questions you always ask of a collection and read fine empty — READY · 0 is information.
    const settled = LIBRARY.filter((a) => !["c", "e"].includes(a.curatorId));
    const values = filterChips(collectionCounts(settled)).map((c) => c.value);
    expect(values).not.toContain("stuck");
    expect(values).not.toContain("roadie");
    expect(values).not.toContain("only-card");
    expect(values).not.toContain("only-tags");
    expect(values).toEqual(
      expect.arrayContaining(["needs", "ready", "visualizer", "card", "tags"]),
    );
  });

  it("brings NOT STARTED back the moment Roadie is holding something", () => {
    // Dropping it at zero must not be deletion: a record mid-process is matched by no work filter,
    // so without the chip it would be reachable only through EVERYTHING (the hole ADR 0070 closed).
    const settled = LIBRARY.filter((a) => !["c", "e"].includes(a.curatorId));
    const importing = [
      ...settled,
      album({ curatorId: "new", state: "fetching_metadata" }),
    ];
    expect(filterChips(collectionCounts(importing))).toContainEqual({
      value: "roadie",
      label: "NOT STARTED",
      count: 1,
    });
  });

  it("covers every state a record can be in", () => {
    // The guard against adding a state to `RecordState` and forgetting the chip that reaches it.
    const values = filterChips(collectionCounts(LIBRARY)).map((c) => c.value);
    for (const kind of ["needs", "ready", "roadie", "stuck"])
      expect(values).toContain(kind);
  });
});

describe("the last-mile chips (ADR 0071)", () => {
  // The shape that motivated this: a collection midway through its visualizers, where NEEDS
  // SIGN-OFF is true of nearly everything and so tells you nothing about what you can finish.
  // Both halves of `tagsDone` have to be undone: a physical verification alone settles the need,
  // so clearing `tagsWritten` without it leaves a record that silently owes nothing.
  const owesTag = {
    tagsWritten: false,
    physicallyVerifiedAt: null,
    state: "awaiting_review" as const,
  };
  const MIDWAY: AlbumSummary[] = [
    // Owes a tag and nothing else — the pile you can clear in an afternoon.
    album({ curatorId: "t1", ...done, ...owesTag }),
    album({ curatorId: "t2", ...done, ...owesTag }),
    // Owes a tag too, but is also missing a visualizer — not last-mile.
    album({ curatorId: "v1", ...done, ...owesTag, hasVideo: false }),
    album({ curatorId: "v2", ...done, ...owesTag, hasVideo: false }),
    album({ curatorId: "done", ...done }),
  ];

  it("shows the records a need is ALL that's left of, not every record that owes it", () => {
    const owes = visibleTiles(MIDWAY, { filter: "tags", query: "", seed: 1 });
    const only = visibleTiles(MIDWAY, {
      filter: "only-tags",
      query: "",
      seed: 1,
    });
    expect(owes.map((t) => t.album.curatorId).sort()).toEqual([
      "t1",
      "t2",
      "v1",
      "v2",
    ]);
    expect(only.map((t) => t.album.curatorId).sort()).toEqual(["t1", "t2"]);
  });

  it("never shows a record that is ready, held, or stuck", () => {
    const ids = visibleTiles(LIBRARY, {
      filter: "only-visualizer",
      query: "",
      seed: 1,
    }).map((t) => t.album.curatorId);
    // "b" owes a visualizer and nothing else. "d" is ready, "c" is Roadie's, "e" is stuck.
    expect(ids).toEqual(["b"]);
  });

  it("labels the tile as the chip does, without needing to relabel it", () => {
    // A need that is the only one outstanding is also the first, so `recordState` already agrees —
    // unlike a plain need chip, which has to overwrite the label to stop the grid looking leaky.
    const tiles = visibleTiles(MIDWAY, {
      filter: "only-tags",
      query: "",
      seed: 1,
    });
    expect(tiles.map((t) => stateLabel(t.state))).toEqual([
      "NEEDS SIGN-OFF",
      "NEEDS SIGN-OFF",
    ]);
  });

  it("still answers to the search", () => {
    const named = MIDWAY.map((a, i) =>
      i === 0 ? { ...a, title: "Rumours" } : a,
    );
    expect(
      visibleTiles(named, {
        filter: "only-tags",
        query: "rumours",
        seed: 1,
      }).map((t) => t.album.curatorId),
    ).toEqual(["t1"]);
  });

  it("counts what the chip opens, for every need", () => {
    // The same pairing that keeps `byOutstanding` honest, applied to `byOnly`.
    const counts = collectionCounts(MIDWAY);
    expect(counts.byOnly).toEqual({ visualizer: 0, card: 0, tags: 2 });
    for (const need of ["visualizer", "card", "tags"] as const)
      expect(
        visibleTiles(MIDWAY, {
          filter: onlyNeedFilter(need),
          query: "",
          seed: 1,
        }),
      ).toHaveLength(counts.byOnly[need]);
  });

  it("never claims more records than NOT COMPLETE", () => {
    // byOutstanding may exceed notComplete (a record owing two things is in both chips); byOnly
    // cannot, because a record with one need left is counted exactly once and one with two is
    // counted nowhere. A byOnly that outran notComplete would mean the predicate had drifted.
    for (const lib of [LIBRARY, MIDWAY, []]) {
      const c = collectionCounts(lib);
      const summed = NEED_ORDER.reduce((n, need) => n + c.byOnly[need], 0);
      expect(summed).toBeLessThanOrEqual(c.notComplete);
    }
  });

  it("coincides with byNeed for the last need in reading order, and only that one", () => {
    // Nothing can outrank the last need, so being first there is being alone. This is why the
    // grouped view under NOT COMPLETE already held exactly the JUST NEEDS SIGN-OFF pile.
    const c = collectionCounts(MIDWAY);
    const last = NEED_ORDER[NEED_ORDER.length - 1]!;
    expect(c.byOnly[last]).toBe(c.byNeed[last]);
    // Not a general law: "v1"/"v2" make visualizer first for two records but alone for none.
    expect(c.byNeed.visualizer).toBe(2);
    expect(c.byOnly.visualizer).toBe(0);
  });
});

describe("the filter that comes back out of the URL", () => {
  it("accepts every value a chip can set", () => {
    for (const { value } of filterChips(collectionCounts(LIBRARY)))
      expect(parseFilter(value)).toBe(value);
  });

  it("accepts a last-mile filter even when its chip is dropped at zero", () => {
    // The chip vanishes at zero but the URL is durable — a bookmarked ?filter=only-card must land
    // on an honest empty grid, not silently widen to the whole collection.
    const settled = LIBRARY.filter((a) => !["c", "e"].includes(a.curatorId));
    expect(
      filterChips(collectionCounts(settled)).map((c) => c.value),
    ).not.toContain("only-card");
    expect(parseFilter("only-card")).toBe("only-card");
    expect(
      visibleTiles(settled, { filter: "only-card", query: "", seed: 1 }),
    ).toEqual([]);
  });

  it("falls back to the whole collection rather than to an empty grid", () => {
    // `?filter=banana` is one hand-edited URL away, and a blank wall with no chip pressed reads as
    // a broken app — the same lesson as `?density=banana`. `only-banana` is the new near-miss: it
    // must not slice into a Need-shaped value that nothing validates.
    for (const junk of [
      "banana",
      "",
      "NEEDS",
      "lights",
      "only-",
      "only-banana",
      null,
    ])
      expect(parseFilter(junk)).toBe("all");
  });
});

describe("grouping", () => {
  const tiles = visibleTiles(LIBRARY, { filter: "needs", query: "", seed: 3 });

  it("groups under the same labels the tiles use", () => {
    expect(groupByNeed(tiles).map((g) => g.label)).toEqual([
      "NEEDS VISUALIZER",
    ]);
  });

  it("puts each record in exactly one group, even when it owes more than one thing", () => {
    // "a" owes all three. The groups are the one view that stays first-need, so that working down
    // NOT COMPLETE never shows you the same sleeve twice — unlike the per-need chips (ADR 0070).
    const ids = groupByNeed(tiles).flatMap((g) =>
      g.tiles.map((t) => t.album.curatorId),
    );
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toContain("a");
  });

  it("does not render an empty group at all", () => {
    // Needs Card and Needs Sign-off are nobody's *first* need today, so they aren't drawn — a
    // heading with nothing under it reads as a category you failed to clear.
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
    // "a" is missing all three; it counts once, under visualizer.
    expect(collectionCounts(LIBRARY).byNeed).toEqual({
      visualizer: 2,
      card: 0,
      tags: 0,
    });
  });

  it("counts every outstanding need separately, overlaps and all", () => {
    // What the per-need chips say (ADR 0070). "a" owes all three and appears in all three; the
    // total is deliberately larger than notComplete, which is 2.
    expect(collectionCounts(LIBRARY).byOutstanding).toEqual({
      visualizer: 2,
      card: 1,
      tags: 1,
    });
    expect(collectionCounts(LIBRARY).notComplete).toBe(2);
  });

  it("agrees with what clicking each chip actually shows", () => {
    // The number on a chip and the size of the grid it opens are two derivations of one fact, and
    // this is the pairing that keeps them honest.
    const counts = collectionCounts(LIBRARY);
    for (const need of ["visualizer", "card", "tags"] as const) {
      const shown = visibleTiles(LIBRARY, {
        filter: need,
        query: "",
        seed: 1,
      });
      expect(shown).toHaveLength(counts.byOutstanding[need]);
    }
  });

  it("spells the detail line as a sentence, and agrees with itself", () => {
    expect(notCompleteDetail(collectionCounts(LIBRARY))).toBe(
      "two still need a visualizer",
    );
    expect(
      notCompleteDetail(
        collectionCounts([
          ...LIBRARY,
          album({ curatorId: "f", title: "Rumours", artist: "Fleetwood Mac" }),
          album({ curatorId: "g", title: "Voodoo", artist: "D'Angelo" }),
        ]),
      ),
    ).toBe("four still need a visualizer");
    expect(
      notCompleteDetail(
        collectionCounts(LIBRARY.filter((a) => a.curatorId === "d")),
      ),
    ).toBe("nothing outstanding");
  });

  it("never claims more records than the NOT COMPLETE total it sits under", () => {
    // The detail line reads off byNeed, not byOutstanding, precisely so it can't say "four still
    // need a card" beneath a total of 2.
    const counts = collectionCounts(LIBRARY);
    for (const n of Object.values(counts.byNeed))
      expect(n).toBeLessThanOrEqual(counts.notComplete);
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
