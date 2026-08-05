// The rotating statistic (ADR 0052). The pool is built from what has data, so a field the assets
// don't carry yet (label) shortens the rotation rather than drawing an empty cell.
import { describe, it, expect } from "vitest";
import type { AlbumSummary } from "./api";
import { statsFor } from "./collectionStats";

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
    state: "verified",
    artwork: null,
    paletteColors: 3,
    hasVideo: true,
    year: 1977,
    genres: ["rock"],
    paletteHexes: [],
    hasCardArt: true,
    tagsWritten: true,
    previewApprovedAt: "2026-08-01T10:00:00.000Z",
    physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const LIBRARY = [
  album({
    curatorId: "a",
    title: "Kind of Blue",
    artist: "Miles Davis",
    year: 1959,
    genres: ["jazz"],
  }),
  album({
    curatorId: "b",
    title: "Bitches Brew",
    artist: "Miles Davis",
    year: 1970,
    genres: ["jazz"],
  }),
  album({
    curatorId: "c",
    title: "Rumours",
    artist: "Fleetwood Mac",
    year: 1977,
  }),
  album({
    curatorId: "d",
    title: "The Idler Wheel",
    artist: "Fiona Apple",
    year: 2012,
    genres: ["pop"],
  }),
];

describe("statsFor", () => {
  it("offers only the statistics there is data for", () => {
    // Four today, not five: `label` isn't stored on an asset yet (ADR 0052). When it lands, the
    // rotation becomes five without a change here — that is the point of building the pool.
    expect(statsFor(LIBRARY).map((s) => s.key)).toEqual([
      "decade",
      "genre",
      "artist",
      "span",
    ]);
  });

  it("buckets by decade and marks exactly one bar as the tallest", () => {
    const decade = statsFor(LIBRARY).find((s) => s.key === "decade")!;
    expect(decade.kind).toBe("bars");
    if (decade.kind !== "bars") throw new Error("expected bars");
    expect(decade.bars.map((b) => b.label)).toEqual([
      "50s",
      "60s",
      "70s",
      "80s",
      "90s",
      "00s+",
    ]);
    expect(decade.bars.filter((b) => b.hot)).toHaveLength(1);
    expect(decade.bars.find((b) => b.label === "70s")!.hot).toBe(true);
  });

  it("floors a bar's height so a count of one is still visible", () => {
    const decade = statsFor(LIBRARY).find((s) => s.key === "decade")!;
    if (decade.kind !== "bars") throw new Error("expected bars");
    // The 80s and 90s hold nothing; the 50s holds one against a tallest of two.
    expect(
      Math.min(...decade.bars.map((b) => b.height)),
    ).toBeGreaterThanOrEqual(6);
  });

  it("names the top artist and agrees with itself about the plural", () => {
    const artist = statsFor(LIBRARY).find((s) => s.key === "artist")!;
    if (artist.kind !== "text") throw new Error("expected text");
    expect(artist.big).toBe("Miles Davis");
    expect(artist.sub).toBe("2 records — more than anyone else");

    const one = statsFor([LIBRARY[0]!]).find((s) => s.key === "artist")!;
    if (one.kind !== "text") throw new Error("expected text");
    expect(one.sub).toBe("1 record — more than anyone else");
  });

  it("spans oldest to newest by title, not by id", () => {
    const span = statsFor(LIBRARY).find((s) => s.key === "span")!;
    if (span.kind !== "text") throw new Error("expected text");
    expect(span.big).toBe("1959 → 2012");
    expect(span.sub).toBe("Kind of Blue to The Idler Wheel");
  });

  it("drops the span when every record is from the same year", () => {
    const sameYear = LIBRARY.map((a) => ({ ...a, year: 1977 }));
    expect(statsFor(sameYear).map((s) => s.key)).not.toContain("span");
  });

  it("returns nothing at all for an empty collection rather than throwing", () => {
    expect(statsFor([])).toEqual([]);
  });

  it("survives records with no year and no genre", () => {
    const bare = [
      album({ curatorId: "x", year: null, genres: [] }),
      album({ curatorId: "y", year: null, genres: [] }),
    ];
    expect(statsFor(bare).map((s) => s.key)).toEqual(["artist"]);
  });
});
