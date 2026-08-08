// What a record still needs (ADR 0052). The derivation is the model the whole overhaul rests on —
// if it drifts, the collection and the record page start disagreeing about the same record.
import { describe, it, expect } from "vitest";
import type { AlbumAsset, AlbumSummary, RoadieState } from "./api";
import {
  failureSentence,
  needFactsOfAsset,
  outstandingNeeds,
  recordState,
  roadieNarration,
  stateLabel,
  NEED_LABEL,
  NEED_ORDER,
  SECTION_ORDER,
  SECTION_TAB_LABEL,
  isNeedSection,
} from "./needs";

const album = (over: Partial<AlbumSummary> = {}): AlbumSummary => ({
  curatorId: "abc12345",
  title: "Kind of Blue",
  artist: "Miles Davis",
  source: "manual",
  createdAt: "2026-08-01T00:00:00.000Z",
  state: "awaiting_review",
  artwork: "/art.jpg",
  paletteColors: 3,
  hasVideo: false,
  year: 1959,
  genres: ["jazz"],
  paletteHexes: ["#132632", "#1F4F6B"],
  hasCardArt: false,
  tagsWritten: false,
  previewApprovedAt: null,
  physicallyVerifiedAt: null,
  subState: null,
  lastError: null,
  ...over,
});

/** Everything done — the baseline the cases below take one thing away from. */
const complete = (over: Partial<AlbumSummary> = {}) =>
  album({
    state: "verified",
    hasVideo: true,
    hasCardArt: true,
    tagsWritten: true,
    previewApprovedAt: "2026-08-01T10:00:00.000Z",
    physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
    ...over,
  });

describe("outstandingNeeds", () => {
  it("reads a finished record as needing nothing", () => {
    expect(outstandingNeeds(complete())).toEqual([]);
  });

  it("lists every missing thing, in reading order", () => {
    expect(outstandingNeeds(album())).toEqual([
      "lights",
      "visualizer",
      "card",
      "tags",
    ]);
  });

  it("treats the four as independent — any one can be outstanding on its own", () => {
    expect(outstandingNeeds(complete({ hasVideo: false }))).toEqual([
      "visualizer",
    ]);
    expect(outstandingNeeds(complete({ hasCardArt: false }))).toEqual(["card"]);
    expect(
      outstandingNeeds(
        complete({ previewApprovedAt: null, state: "awaiting_preview" }),
      ),
    ).toEqual(["lights"]);
  });

  it("counts lights as done once the preview is approved, not once a palette exists", () => {
    // Every record has a palette within seconds of being added; approving it means having watched
    // it in the room, which is why the room owns the button.
    expect(outstandingNeeds(album({ paletteColors: 5 }))).toContain("lights");
    expect(
      outstandingNeeds(
        complete({
          previewApprovedAt: "2026-08-01T10:00:00.000Z",
          state: "awaiting_video",
        }),
      ),
    ).not.toContain("lights");
  });

  it("counts tags as done only when they are written AND checked", () => {
    const written = complete({
      physicallyVerifiedAt: null,
      state: "awaiting_verify",
    });
    expect(outstandingNeeds(written)).toEqual(["tags"]);
    expect(
      outstandingNeeds({
        ...written,
        physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
      }),
    ).toEqual([]);
  });
});

describe("the labels name the act, not the artifact", () => {
  // The rule the lights label broke (ADR 0056). A record has a full palette within seconds of
  // landing, so a label built from the *artifact* claims something false for the entire life of the
  // record — which is how a finished Roadie came to look like a broken one on a 500-record
  // collection. `visualizer` and `card` are allowed to read as their artifact because there really
  // isn't one; `lights` and `tags` are not.
  it("never says a record lacks lights, because it never does", () => {
    const lit = album({ paletteColors: 4, previewApprovedAt: null });
    // The palette is there and the need is still outstanding — that pairing is the whole point.
    expect(lit.paletteColors).toBeGreaterThan(0);
    expect(outstandingNeeds(lit)).toContain("lights");
    expect(NEED_LABEL.lights).not.toMatch(/LIGHTS|PALETTE|COLOUR|COLOR/);
  });

  it("never says a record lacks tags, only that they want checking", () => {
    const written = album({ tagsWritten: true, physicallyVerifiedAt: null });
    expect(outstandingNeeds(written)).toContain("tags");
    expect(NEED_LABEL.tags).not.toMatch(/\bTAGS?\b/);
  });
});

describe("recordState", () => {
  it("shows the first outstanding need only, never a count", () => {
    const s = recordState(album());
    expect(s).toEqual({ kind: "needs", need: "lights" });
    expect(stateLabel(s)).toBe("NEEDS A LOOK");
  });

  it("reads a finished record as ready", () => {
    expect(recordState(complete())).toEqual({ kind: "ready" });
    expect(stateLabel({ kind: "ready" })).toBe("READY");
  });

  it("says Roadie is on it while Roadie holds the record", () => {
    for (const state of [
      "fresh",
      "fetching_metadata",
      "downloading_art",
      "generating_palette",
      "drafting_prompts",
    ] as RoadieState[]) {
      expect(recordState(album({ state }))).toEqual({ kind: "roadie" });
    }
  });

  it("puts a failed record in the stuck group whatever else is missing", () => {
    const s = recordState(
      album({
        state: "errored",
        lastError: { message: "boom", reason: "spotify_lookup_failed" },
      }),
    );
    expect(s.kind).toBe("stuck");
    expect(s.kind === "stuck" && s.sentence).toMatch(/couldn't find this/i);
  });
});

describe("the vocabulary", () => {
  it("never says a machine state name or a rejected word", () => {
    const said = [
      ...Object.values(NEED_LABEL),
      stateLabel({ kind: "ready" }),
      stateLabel({ kind: "roadie" }),
      stateLabel({ kind: "stuck", sentence: "" }),
      roadieNarration("downloading_art"),
      roadieNarration("generating_palette"),
    ].join(" | ");
    expect(said).not.toMatch(
      /awaiting|wants you|fully lit|errored|processing|palette|_/i,
    );
  });

  it("turns a raw error code into a sentence with a way out", () => {
    expect(
      failureSentence({ message: "x", reason: "spotify_lookup_failed" }),
    ).toBe(
      "Roadie couldn't find this anywhere — try a different name, or type the details in yourself",
    );
  });

  it("falls back to the server's message rather than inventing one", () => {
    expect(failureSentence({ message: "The disk is full" })).toBe(
      "The disk is full",
    );
    expect(failureSentence(null)).toMatch(/try it again/i);
  });

  it("narrates what Roadie is doing in words, not state names", () => {
    expect(roadieNarration("downloading_art")).toBe("FINDING THE SLEEVE…");
    expect(roadieNarration("fresh")).toBe("NEXT IN LINE");
    expect(roadieNarration("verified")).toBe("ROADIE IS ON IT");
  });
});

/**
 * The demo cut (ADR 0058) is a *section* of the record page and never a `Need`.
 *
 * The separation is what stops 500 finished records growing a permanent outstanding item: the
 * collection labels the first outstanding need, and a record with no demo cut is complete. These
 * pin the boundary rather than the current membership, so adding a sixth section can't quietly
 * make it a need.
 */
describe("sections vs needs", () => {
  it("carries the four needs, in order, plus the demo cut last", () => {
    expect(SECTION_ORDER).toEqual([...NEED_ORDER, "demo"]);
    expect(SECTION_TAB_LABEL.demo).toBe("A demo cut");
  });

  it("calls the four needs needs, and the demo cut not one", () => {
    for (const need of NEED_ORDER) expect(isNeedSection(need)).toBe(true);
    expect(isNeedSection("demo")).toBe(false);
  });

  it("never lists the demo cut among a record's outstanding needs", () => {
    // Nothing done at all — the state where every need is outstanding — still owes no demo cut.
    const nothing = album({
      previewApprovedAt: undefined,
      hasVideo: false,
      hasCardArt: false,
      tagsWritten: false,
      physicallyVerifiedAt: undefined,
    });
    expect(outstandingNeeds(nothing)).toEqual(NEED_ORDER);
    expect(outstandingNeeds(nothing)).not.toContain("demo");
  });

  it("has no label for it in the collection's need vocabulary", () => {
    expect(Object.keys(NEED_LABEL)).toEqual(NEED_ORDER);
  });
});

/**
 * The room holds a full asset, not a collection row, and has to answer "was that the last need?"
 * the instant a sign-off lands (ADR 0063). Two derivations would be two chances to disagree about
 * the same record, which is the thing `needs.ts` exists to prevent — so the asset is reduced to the
 * same facts and run through the same predicates. These cases pin that the reduction matches the
 * server's `summary()`.
 */
describe("needFactsOfAsset", () => {
  const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
    ({
      curatorId: "abc12345",
      createdAt: "2026-08-01T00:00:00.000Z",
      metadata: { name: "Kind of Blue", artist: "Miles Davis" },
      roadie: { state: "awaiting_review" },
      ...over,
    }) as AlbumAsset;

  it("reads a bare record as owing all four", () => {
    expect(outstandingNeeds(needFactsOfAsset(asset()))).toEqual(NEED_ORDER);
  });

  it("counts both stickers, never one — same rule as the collection row", () => {
    const oneOfTwo = asset({
      tag: { payload: "p", sleeve: { written: true } },
    } as Partial<AlbumAsset>);
    expect(needFactsOfAsset(oneOfTwo).tagsWritten).toBe(false);

    const both = asset({
      tag: { payload: "p", sleeve: { written: true }, card: { written: true } },
    } as Partial<AlbumAsset>);
    expect(needFactsOfAsset(both).tagsWritten).toBe(true);
  });

  it("reads a fully-finished record as owing nothing", () => {
    const done = asset({
      roadie: { state: "verified" },
      visualizer: { fileId: "abc12345" },
      cardArt: { fileId: "abc12345" },
      tag: { payload: "p", sleeve: { written: true }, card: { written: true } },
      verification: {
        previewApprovedAt: "2026-08-01T10:00:00.000Z",
        physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
      },
    } as Partial<AlbumAsset>);
    expect(outstandingNeeds(needFactsOfAsset(done))).toEqual([]);
  });

  it("agrees with the collection row about the same record", () => {
    // regression: #263 — the room decides whether to fire the ready toast from the asset while the
    // collection draws the tile from the row. If those two ever part company, one of the screens is
    // lying about a record the other has right.
    const signedOffOnly = asset({
      verification: { previewApprovedAt: "2026-08-01T10:00:00.000Z" },
    } as Partial<AlbumAsset>);
    const row = album({ previewApprovedAt: "2026-08-01T10:00:00.000Z" });
    expect(outstandingNeeds(needFactsOfAsset(signedOffOnly))).toEqual(
      outstandingNeeds(row),
    );
  });
});
