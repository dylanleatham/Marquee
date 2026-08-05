// What a record still needs (ADR 0052). The derivation is the model the whole overhaul rests on —
// if it drifts, the collection and the record page start disagreeing about the same record.
import { describe, it, expect } from "vitest";
import type { AlbumSummary, RoadieState } from "./api";
import {
  failureSentence,
  outstandingNeeds,
  recordState,
  roadieNarration,
  stateLabel,
  NEED_LABEL,
} from "./needs";

const album = (over: Partial<AlbumSummary> = {}): AlbumSummary => ({
  curatorId: "abc12345",
  title: "Kind of Blue",
  artist: "Miles Davis",
  source: "manual",
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

describe("recordState", () => {
  it("shows the first outstanding need only, never a count", () => {
    const s = recordState(album());
    expect(s).toEqual({ kind: "needs", need: "lights" });
    expect(stateLabel(s)).toBe("NEEDS LIGHTS");
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
