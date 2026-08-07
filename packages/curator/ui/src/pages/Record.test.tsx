// The record (ADR 0052) — the page that replaced the five-station rail.
//
// The rules worth pinning are the ones the rail broke: every need is reachable in any order, none
// is gated, the page always opens on the same tab, and no machine state name reaches the screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../api", () => ({
  api: {
    album: vi.fn(),
    geminiSettings: vi
      .fn()
      .mockResolvedValue({ generateCardArt: false, generateVideo: false }),
    editPalette: vi.fn().mockResolvedValue({}),
    choosePalette: vi.fn().mockResolvedValue({}),
    feelingPalette: vi.fn().mockResolvedValue({}),
    albumJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    tagPayload: vi.fn().mockResolvedValue({ payload: "", qrDataUrl: "" }),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  cardArtUrl: (id: string) => `/api/albums/${id}/card-art`,
  cardArtCandidateUrl: (id: string, i: number) => `/c/${id}/${i}`,
  cardArtPrintUrl: (id: string) => `/p/${id}`,
  videoClipUrl: (id: string, i: number) => `/v/${id}/${i}`,
  videoClipThumbnailUrl: (id: string, i: number) => `/vt/${id}/${i}`,
  videoClipDownloadUrl: (id: string, i: number) => `/vd/${id}/${i}`,
  thumbnailUrl: (id: string) => `/t/${id}`,
  activePromptText: () => "",
  ApiError: class extends Error {},
}));

import { api, type AlbumAsset, type AlbumSummary } from "../api";
import { Record } from "./Record";

const ASSET = {
  curatorId: "2k7bxq9m",
  createdAt: "2026-08-01T00:00:00.000Z",
  metadata: {
    name: "Purple Rain",
    artist: "Prince",
    year: 1984,
    source: "manual",
  },
  artwork: { resolvedPath: "/a.jpg", contentHash: "h" },
  palette: {
    colors: [
      { hex: "#4B0082", role: "primary" },
      { hex: "#8A2BE2", role: "secondary" },
    ],
    source: "cover",
  },
  roadie: {
    state: "awaiting_review",
    subState: null,
    flags: {
      palette_insufficient: false,
      album_not_on_spotify: false,
      art_override_active: false,
    },
    history: [],
    lastError: null,
    retryCount: 0,
  },
  status: { highLevel: "", next: null, issues: [] },
} as unknown as AlbumAsset;

const row = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
    state: "awaiting_review",
    artwork: null,
    paletteColors: 2,
    hasVideo: false,
    year: 1984,
    genres: [],
    paletteHexes: [],
    hasCardArt: false,
    tagsWritten: false,
    previewApprovedAt: null,
    physicallyVerifiedAt: null,
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const ALBUMS = [
  row({ curatorId: "aaaa1111", title: "Aja" }),
  row({ curatorId: "2k7bxq9m", title: "Purple Rain", artist: "Prince" }),
  row({ curatorId: "zzzz9999", title: "Blue" }),
];

const show = (
  at = "/albums/2k7bxq9m",
  albums: AlbumSummary[] | null = ALBUMS,
) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/albums/:curatorId" element={<Record albums={albums} />} />
        <Route
          path="/albums/:curatorId/:section"
          element={<Record albums={albums} />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.album).mockResolvedValue(ASSET);
});
afterEach(cleanup);

const loaded = () => screen.findByRole("heading", { name: "Purple Rain" });

describe("Record — the sidebar", () => {
  it("names the record and where it came from, without a state name", async () => {
    show();
    await loaded();
    expect(screen.getByText("Prince · 1984")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/awaiting_review|Awaiting/);
  });

  it("shows the id exactly once, small and out of the way", async () => {
    // The one place ADR 0052 permits an id. It must not appear in a sentence anywhere else.
    show();
    await loaded();
    const ids = screen.getAllByText("2k7bxq9m");
    expect(ids).toHaveLength(1);
    expect(ids[0]!.className).toContain("record__id");
  });

  it("offers the room, which is where the lights get signed off", async () => {
    show();
    await loaded();
    expect(
      screen
        .getByRole("link", { name: /SEE IT IN THE ROOM/ })
        .getAttribute("href"),
    ).toBe("/room/2k7bxq9m");
  });

  it("walks the collection with prev/next, and does not wrap", async () => {
    show();
    await loaded();
    // Neighbours come from the album list, not the old same-state buckets — a run through those
    // would step by a rule nothing on screen explains.
    expect(screen.getByRole("button", { name: "↑ PREV" }).title).toBe("Aja");
    expect(screen.getByRole("button", { name: "NEXT ↓" }).title).toBe("Blue");

    cleanup();
    show("/albums/zzzz9999");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "NEXT ↓" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "NEXT ↓" }).title).toBe(
      "That was the last one",
    );
  });
});

describe("Record — the needs tabs", () => {
  it("opens on Lights whatever is outstanding", async () => {
    show();
    await loaded();
    expect(
      screen
        .getByRole("button", { name: /Lights/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText(/edits save as you make them/)).toBeTruthy();
  });

  it("offers all four, none of them gated", async () => {
    // The rail's whole failure mode: arriving holding an artifact for a later step and being unable
    // to hand it over. Every tab is always open.
    show();
    await loaded();
    for (const label of ["Lights", "A visualizer", "A card", "Tags"]) {
      const tab = screen.getByRole("button", { name: new RegExp(label) });
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("marks what is done with a glyph and a word, never colour alone", async () => {
    show();
    await loaded();
    const lights = screen.getByRole("button", { name: /Lights/ });
    expect(lights.textContent).toContain("○");
    expect(lights.textContent).toContain("still needed");
  });

  it("swaps the panel without leaving the page", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /A card/ }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /A card/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    // Still the same record — the sidebar never unmounted.
    expect(screen.getByRole("heading", { name: "Purple Rain" })).toBeTruthy();
  });

  it("falls back to Lights for a segment that isn't a need", async () => {
    show("/albums/2k7bxq9m/banana");
    await loaded();
    expect(
      screen
        .getByRole("button", { name: /Lights/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("Record — states it owes", () => {
  it("says it is loading rather than rendering an empty record", () => {
    show();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("reports a failed fetch", async () => {
    vi.mocked(api.album).mockRejectedValue(new Error("nope"));
    show();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this record/)).toBeTruthy(),
    );
  });

  it("renders before the album list arrives, with the run controls simply idle", async () => {
    show("/albums/2k7bxq9m", null);
    await loaded();
    expect(
      (screen.getByRole("button", { name: "↑ PREV" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("Record — the retired rail", () => {
  it("has no rail, no stepper and no ⌘⏎ hint", async () => {
    show();
    await loaded();
    expect(document.querySelector("nav.rail")).toBeNull();
    expect(document.querySelector(".stepper")).toBeNull();
    expect(document.body.textContent).not.toMatch(/⌘⏎|Preview & approve/);
  });

  it("binds no keyboard shortcuts", async () => {
    const spy = vi.spyOn(window, "addEventListener");
    show();
    await loaded();
    expect(spy.mock.calls.filter(([t]) => t === "keydown")).toHaveLength(0);
    spy.mockRestore();
  });
});
