import { describe, it, expect } from "vitest";
import {
  WORKSTATIONS,
  READINESS_LABEL,
  readiness,
  defaultWorkstation,
  workstationFromSegment,
  type WorkstationId,
} from "./rail";
import type { AlbumAsset, RoadieState } from "./api";

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-07-25T00:00:00.000Z",
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
    roadie: {
      state: "awaiting_review",
      subState: null,
      flags: {},
      history: [],
      lastError: null,
      retryCount: 0,
    },
    status: { highLevel: "awaiting_review", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const withPalette = (over: Partial<AlbumAsset> = {}) =>
  asset({
    palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
    ...over,
  });

describe("the rail", () => {
  it("has exactly the five specced workstations, in order", () => {
    expect(WORKSTATIONS.map((w) => w.id)).toEqual([
      "look",
      "video",
      "card",
      "preview",
      "ship",
    ]);
  });

  it("gives every workstation a unique route segment", () => {
    const segments = WORKSTATIONS.map((w) => w.segment);
    expect(new Set(segments).size).toBe(segments.length);
  });

  // curator-ui-ux §3.4: colour is never the only channel. A dot alone is not a status.
  it("gives every readiness a word, not just a colour", () => {
    for (const key of ["empty", "ready", "attached", "blocked"] as const) {
      expect(READINESS_LABEL[key]).toBeTruthy();
    }
  });
});

describe("readiness", () => {
  it("reports Look empty with no palette, ready with one", () => {
    expect(readiness("look", asset())).toBe("empty");
    expect(readiness("look", withPalette())).toBe("ready");
  });

  it("flags a monochrome palette as needing attention", () => {
    expect(
      readiness(
        "look",
        withPalette({ palette: { colors: [], insufficient: true } }),
      ),
    ).toBe("blocked");
  });

  it("reports Video attached once a visualizer exists, ready on clips or a prompt", () => {
    expect(readiness("video", withPalette())).toBe("empty");
    expect(
      readiness("video", withPalette({ videoClips: [{ index: 0 } as never] })),
    ).toBe("ready");
    expect(
      readiness("video", withPalette({ visualizer: { fileId: "x" } as never })),
    ).toBe("attached");
  });

  it("reports Card attached once card art exists, ready on candidates or a prompt", () => {
    expect(readiness("card", withPalette())).toBe("empty");
    expect(
      readiness(
        "card",
        withPalette({ cardArtCandidates: [{ index: 0 } as never] }),
      ),
    ).toBe("ready");
    expect(
      readiness("card", withPalette({ cardArt: { fileId: "x" } as never })),
    ).toBe("attached");
  });

  it("reports Preview attached only once it has been approved", () => {
    expect(readiness("preview", asset())).toBe("empty");
    expect(readiness("preview", withPalette())).toBe("ready");
    expect(
      readiness(
        "preview",
        withPalette({
          verification: { previewApprovedAt: "2026-07-25T01:00:00Z" },
        }),
      ),
    ).toBe("attached");
  });

  it("reports Ship ready once the sleeve tag is written, attached once verified", () => {
    expect(readiness("ship", withPalette())).toBe("empty");
    expect(
      readiness(
        "ship",
        withPalette({ tag: { payload: "p", sleeve: { written: true } } }),
      ),
    ).toBe("ready");
    expect(
      readiness(
        "ship",
        withPalette({
          tag: { payload: "p", sleeve: { written: true } },
          verification: { physicallyVerifiedAt: "2026-07-25T02:00:00Z" },
        }),
      ),
    ).toBe("attached");
  });

  // The workbench rule: readiness is information, never permission. An album mid-pipeline with no
  // palette still reports a readiness for every station — nothing is absent, nothing is undefined.
  it("returns a readiness for every workstation even on a bare, still-processing album", () => {
    const processing = asset({
      roadie: { ...asset().roadie, state: "fetching_metadata" },
    });
    for (const w of WORKSTATIONS) {
      expect(READINESS_LABEL[readiness(w.id, processing)]).toBeTruthy();
    }
  });
});

describe("defaultWorkstation", () => {
  const cases: Array<[RoadieState, WorkstationId]> = [
    ["awaiting_review", "look"],
    ["awaiting_video", "video"],
    ["awaiting_preview", "preview"],
    ["awaiting_tag_write", "ship"],
    ["awaiting_verify", "ship"],
    ["verified", "ship"],
  ];
  it.each(cases)("opens %s at the %s bench", (state, expected) => {
    expect(defaultWorkstation(state)).toBe(expected);
  });

  it("lands off-happy-path albums at Look, where the palette and error live", () => {
    expect(defaultWorkstation("errored")).toBe("look");
    expect(defaultWorkstation("needs_manual")).toBe("look");
    expect(defaultWorkstation("generating_palette")).toBe("look");
  });
});

describe("workstationFromSegment", () => {
  it("resolves a known segment regardless of the album's state", () => {
    // The point of the workbench: a URL wins over the state machine's opinion.
    expect(workstationFromSegment("card", "awaiting_review")).toBe("card");
    expect(workstationFromSegment("ship", "fetching_metadata")).toBe("ship");
  });

  it("falls back to the state default for a missing or bogus segment", () => {
    expect(workstationFromSegment(undefined, "awaiting_video")).toBe("video");
    expect(workstationFromSegment("nonsense", "awaiting_preview")).toBe(
      "preview",
    );
  });
});
