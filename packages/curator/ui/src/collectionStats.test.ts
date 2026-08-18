// The rotating statistic (ADR 0052). The pool is built from what has data, so a field the assets
// don't carry yet (label) shortens the rotation rather than drawing an empty cell.
import { describe, it, expect } from "vitest";
import type { AlbumSummary } from "./api";
import { hueFamily, statsFor } from "./collectionStats";

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
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
    // No `palette`: the fixture carries no palette hexes. `label` still isn't stored on an asset
    // (ADR 0052), so the rotation gains it without a change here — that is the point of the pool.
    expect(statsFor(LIBRARY).map((s) => s.key)).toEqual([
      "decade",
      "genre",
      "artist",
      "span",
      "reach",
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

  it("marks one bar hot even when two rows tie for the tallest", () => {
    // Two decades at two records each. The type promises exactly one accent bar; a tie is ordinary
    // here, not a corner case, and two accents would read as two different answers.
    const tied = [
      album({ curatorId: "a", year: 1971 }),
      album({ curatorId: "b", year: 1972 }),
      album({ curatorId: "c", year: 1981 }),
      album({ curatorId: "d", year: 1982 }),
    ];
    const decade = statsFor(tied).find((s) => s.key === "decade")!;
    if (decade.kind !== "bars") throw new Error("expected bars");
    expect(decade.bars.filter((b) => b.hot)).toHaveLength(1);
    expect(decade.bars.find((b) => b.hot)!.label).toBe("70s");
  });
});

// A sleeve's dominant light, bucketed into a name a person says out loud. The bar's *label* is what
// carries the family — the chart draws in ink and accent like every other one, so this stat has to
// be readable without separating red from green.
describe("hueFamily", () => {
  it("names each family from its dominant colour", () => {
    expect(hueFamily("#d43b2f")).toBe("RED");
    expect(hueFamily("#e8801a")).toBe("AMBER");
    expect(hueFamily("#e8d21a")).toBe("GOLD");
    expect(hueFamily("#2f9e44")).toBe("GREEN");
    expect(hueFamily("#1c6fd4")).toBe("BLUE");
    expect(hueFamily("#8b3fd4")).toBe("PLUM");
  });

  it("keeps every family name short enough to sit on one line in the cell", () => {
    // Not a style rule. All seven families is ordinary for a large collection, and the rotator is
    // drawn for six bars — a seventh narrows each column to 28.4px, and measured in a browser at
    // 864px with all seven present, a six-character name breaks mid-word into ORANG/E there. The
    // label is this chart's only channel for a reader who cannot separate the hues, so it has to
    // stay whole. Five characters is the measured ceiling at that width.
    const families = statsFor(
      [
        "#d43b2f",
        "#e8801a",
        "#e8d21a",
        "#2f9e44",
        "#1c6fd4",
        "#8b3fd4",
        "#7a7d7a",
      ].map((hex, i) => album({ curatorId: `h${i}`, paletteHexes: [hex] })),
    ).find((s) => s.key === "palette")!;
    if (families.kind !== "bars") throw new Error("expected bars");
    expect(families.bars.map((b) => b.label)).toEqual([
      "RED",
      "AMBER",
      "GOLD",
      "GREEN",
      "BLUE",
      "PLUM",
      "MONO",
    ]);
    for (const b of families.bars)
      expect(b.label.length).toBeLessThanOrEqual(5);
  });

  it("calls a grey, a near-black and a near-white MONO rather than guessing a hue", () => {
    // Each of these has an arithmetically real hue and no perceptible one. A black sleeve reported
    // as GREEN because its ink is two percent off is a lie the chart cannot recover from.
    expect(hueFamily("#7a7d7a")).toBe("MONO");
    expect(hueFamily("#050705")).toBe("MONO");
    expect(hueFamily("#fdfefd")).toBe("MONO");
    expect(hueFamily("#808080")).toBe("MONO");
  });

  it("accepts both hex forms and rejects anything that isn't one", () => {
    expect(hueFamily("#f00")).toBe("RED");
    expect(hueFamily("f00")).toBe("RED");
    expect(hueFamily("#ff0000")).toBe("RED");
    expect(hueFamily("")).toBeNull();
    expect(hueFamily("rebeccapurple")).toBeNull();
    expect(hueFamily("#gg0000")).toBeNull();
  });
});

describe("statsFor — sleeve palette", () => {
  const sleeve = (curatorId: string, hex: string) =>
    album({ curatorId, paletteHexes: [hex, "#111111"] });

  const WALL = [
    sleeve("a", "#d43b2f"),
    sleeve("b", "#c9302c"),
    sleeve("c", "#1c6fd4"),
    sleeve("d", "#7a7d7a"),
  ];

  it("counts sleeves by hue family and keeps them in spectrum order", () => {
    const palette = statsFor(WALL).find((s) => s.key === "palette")!;
    if (palette.kind !== "bars") throw new Error("expected bars");
    // RED before BLUE before MONO — the axis is the spectrum, not the ranking.
    expect(palette.bars.map((b) => b.label)).toEqual(["RED", "BLUE", "MONO"]);
    expect(palette.bars.find((b) => b.label === "RED")!.hot).toBe(true);
  });

  it("drops a family nothing lands in, where an empty decade is kept", () => {
    // A decade you own nothing from is a gap in a timeline. A colour you own nothing in is not a gap
    // in anything — and dropping it keeps the chart inside the six bars the cell is drawn for.
    const palette = statsFor(WALL).find((s) => s.key === "palette")!;
    if (palette.kind !== "bars") throw new Error("expected bars");
    expect(palette.bars.map((b) => b.label)).not.toContain("GREEN");
    expect(palette.bars).toHaveLength(3);
  });

  it("reads the dominant light only, not the rest of the palette", () => {
    const misleading = [
      album({
        curatorId: "a",
        paletteHexes: ["#1c6fd4", "#d43b2f", "#d43b2f"],
      }),
      album({ curatorId: "b", paletteHexes: ["#1c6fd4", "#d43b2f"] }),
      album({ curatorId: "c", paletteHexes: ["#1c6fd4"] }),
      album({ curatorId: "d", paletteHexes: ["#2f9e44"] }),
    ];
    const palette = statsFor(misleading).find((s) => s.key === "palette")!;
    if (palette.kind !== "bars") throw new Error("expected bars");
    expect(palette.bars.map((b) => b.label)).toEqual(["GREEN", "BLUE"]);
  });

  it("stays out until four sleeves have a colour to contribute", () => {
    expect(statsFor(WALL.slice(0, 3)).map((s) => s.key)).not.toContain(
      "palette",
    );
    // Records with no palette yet don't count toward the floor, however many of them there are.
    const unlit = [
      ...WALL.slice(0, 3),
      album({ curatorId: "z", paletteHexes: [] }),
      album({ curatorId: "y", paletteHexes: [] }),
    ];
    expect(statsFor(unlit).map((s) => s.key)).not.toContain("palette");
  });

  it("stays out when every sleeve is the same family, because one bar is not a chart", () => {
    const monochrome = ["a", "b", "c", "d", "e"].map((id) =>
      sleeve(id, "#d43b2f"),
    );
    expect(statsFor(monochrome).map((s) => s.key)).not.toContain("palette");
  });
});

describe("statsFor — genre reach", () => {
  const REACHY = [
    album({ curatorId: "a", genres: ["Jazz", "Hard Bop", "Modal"] }),
    album({ curatorId: "b", genres: ["Jazz", "Fusion"] }),
    album({ curatorId: "c", genres: ["Rock", "Psychedelic"] }),
  ];

  it("counts every genre on a record, not just the first", () => {
    // GENRE BREAKDOWN counts only `genres[0]` — that is the pair's whole point. Six distinct here;
    // counting first-only would say two.
    const reach = statsFor(REACHY).find((s) => s.key === "reach")!;
    if (reach.kind !== "text") throw new Error("expected text");
    expect(reach.big).toBe("6 genres");
    expect(reach.sub).toBe("5 of them on one record each");
  });

  it("treats one genre on one record as singular", () => {
    const nearly = [
      album({ curatorId: "a", genres: ["Jazz", "Fusion"] }),
      album({ curatorId: "b", genres: ["Jazz", "Fusion"] }),
      album({ curatorId: "c", genres: ["Jazz", "Fusion", "Modal"] }),
    ];
    const reach = statsFor(nearly).find((s) => s.key === "reach")!;
    if (reach.kind !== "text") throw new Error("expected text");
    expect(reach.sub).toBe("1 of them on a single record");
  });

  it("counts a genre once per record however often that record repeats it", () => {
    const dupes = [
      album({ curatorId: "a", genres: ["Jazz", "jazz", "JAZZ", "Fusion"] }),
      album({ curatorId: "b", genres: ["Rock"] }),
    ];
    const reach = statsFor(dupes).find((s) => s.key === "reach")!;
    if (reach.kind !== "text") throw new Error("expected text");
    // Jazz, Fusion, Rock — and Jazz sits on one record, not three.
    expect(reach.big).toBe("3 genres");
    expect(reach.sub).toBe("3 of them on one record each");
  });

  it("stays out below three genres, where the count says nothing", () => {
    const thin = [
      album({ curatorId: "a", genres: ["Jazz"] }),
      album({ curatorId: "b", genres: ["Jazz", "Fusion"] }),
    ];
    expect(statsFor(thin).map((s) => s.key)).not.toContain("reach");
  });
});
