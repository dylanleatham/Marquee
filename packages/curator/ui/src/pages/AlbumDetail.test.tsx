// The workbench (ADR 0026). The rules worth locking down are the ones the old page got wrong:
// nothing is hidden because of `roadie.state`, every workstation is reachable from every state, and
// a deep link beats the state machine's opinion about where you should be.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AlbumAsset, RoadieState } from "../api";

vi.mock("../api", () => ({
  api: {
    album: vi.fn(),
    geminiSettings: vi.fn(),
    deleteAlbum: vi.fn(),
    retry: vi.fn(),
    draftPrompt: vi.fn(),
    // Ship fetches the tag payload + QR on mount (issue #102), so any case that lands there —
    // `verified` defaults to Ship — needs this stubbed or the bench renders nothing.
    tagPayload: vi.fn().mockResolvedValue({
      object: "sleeve",
      payload: "curator:album:abcd1234",
      qrDataUrl: "data:image/svg+xml;base64,x",
    }),
    uploadArtworkOverride: vi.fn(),
    removeArtworkOverride: vi.fn(),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  thumbnailUrl: (id: string) => `/api/albums/${id}/thumbnail`,
  videoClipUrl: () => "",
  videoClipThumbnailUrl: () => "",
  videoClipDownloadUrl: () => "",
  cardArtUrl: () => "",
  cardArtPrintUrl: () => "",
  cardArtCandidateUrl: () => "",
}));

import { api } from "../api";
import { AlbumDetail } from "./AlbumDetail";

const album = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abcd1234",
    createdAt: "2026-07-25T00:00:00Z",
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
    palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
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
    status: { highLevel: "awaiting_review", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/albums/:curatorId" element={<AlbumDetail />} />
        <Route path="/albums/:curatorId/:section" element={<AlbumDetail />} />
        <Route path="/" element={<div>queue</div>} />
      </Routes>
    </MemoryRouter>,
  );

const RAIL = ["Look", "Video", "Card", "Preview", "Ship"];

/** The rail's links, by label. Scoped to the nav because the bench heading reuses the same words. */
const railLinks = () =>
  Array.from(
    document.querySelectorAll<HTMLAnchorElement>("nav.rail a.rail__item"),
  );
const railLabels = () =>
  railLinks().map((a) => a.querySelector(".rail__label")?.textContent);
/** The heading of the currently-open bench. */
const openBench = () =>
  document.querySelector(".bench__head h2")?.textContent ?? null;

describe("AlbumDetail — the workbench rail", () => {
  beforeEach(() => {
    vi.mocked(api.geminiSettings).mockResolvedValue({
      configured: false,
      generateCardArt: false,
      generateVideo: false,
    } as never);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders all five workstations", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234");

    await waitFor(() => expect(railLinks()).toHaveLength(5));
    expect(railLabels()).toEqual(RAIL);
  });

  it("opens the workstation the URL names, not the one the state suggests", async () => {
    // awaiting_review would default to Look; the URL says Card, and the URL wins.
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234/card");

    await waitFor(() => expect(openBench()).toBe("Card"));
  });

  it("opens the state-derived default when the URL names no workstation", async () => {
    vi.mocked(api.album).mockResolvedValue(
      album({
        roadie: { ...album().roadie, state: "awaiting_tag_write" },
      }),
    );
    renderAt("/albums/abcd1234");

    await waitFor(() => expect(openBench()).toBe("Ship"));
  });

  // The regression the old page had: Preview and Tag&verify were hidden behind state checks, and
  // the whole workflow vanished while Roadie was still processing.
  it.each<RoadieState>([
    "fetching_metadata",
    "generating_palette",
    "awaiting_review",
    "awaiting_video",
    "verified",
    "errored",
  ])("keeps every workstation reachable in state %s", async (state) => {
    vi.mocked(api.album).mockResolvedValue(
      album({ roadie: { ...album().roadie, state } }),
    );
    renderAt("/albums/abcd1234");

    await waitFor(() => expect(railLinks()).toHaveLength(5));
    expect(railLabels()).toEqual(RAIL);
    for (const link of railLinks()) {
      expect(link.getAttribute("href")).toContain("/albums/abcd1234/");
    }
  });

  it("accepts a video for an album Roadie is still processing", async () => {
    // The exact case a state-ordered UI made impossible: you already have the artifact.
    vi.mocked(api.album).mockResolvedValue(
      album({
        palette: undefined,
        roadie: { ...album().roadie, state: "fetching_metadata" },
      }),
    );
    renderAt("/albums/abcd1234/video");

    await waitFor(() => expect(openBench()).toBe("Video"));
    // The Video bench renders its own controls rather than a "come back later" placeholder.
    expect(screen.queryByText(/not generated yet/i)).toBeNull();
  });

  // curator-ui-ux §3.4 — a dot is not a status.
  it("labels every readiness chip with a word, never colour alone", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234");

    await waitFor(() => expect(railLinks()).toHaveLength(5));
    const chips = document.querySelectorAll(".rail__state");
    expect(chips).toHaveLength(5);
    for (const chip of chips) {
      expect(chip.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("shows the Roadie error on the album without hiding the benches", async () => {
    vi.mocked(api.album).mockResolvedValue(
      album({
        roadie: {
          ...album().roadie,
          state: "needs_manual",
          lastError: { reason: "album_not_on_spotify", message: "404" },
        },
      }),
    );
    renderAt("/albums/abcd1234");

    expect(await screen.findByText(/404/)).toBeTruthy();
    expect(railLabels()).toEqual(RAIL);
  });
});
