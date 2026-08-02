// The workbench (ADR 0026). The rules worth locking down are the ones the old page got wrong:
// nothing is hidden because of `roadie.state`, every workstation is reachable from every state, and
// a deep link beats the state machine's opinion about where you should be.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
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
    // The primary actions ⌘⏎ reaches (issue #95), one per workstation that has one.
    editPalette: vi.fn().mockResolvedValue({ palette: null }),
    markTagWritten: vi.fn().mockResolvedValue({ state: "awaiting_verify" }),
    verifyAlbum: vi.fn().mockResolvedValue({ state: "verified" }),
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

/**
 * The detail's keyboard path (curator-ui-ux §9.1). `1`–`5` and `Esc` shipped with the workbench;
 * `⌘⏎` is issue #95. The property that ties them together is the one §9.1 states outright: a
 * shortcut acts on what is on screen, and never silently does nothing — so on a bench with no
 * primary action the header says so, rather than leaving the key to be discovered as a dud.
 */
describe("AlbumDetail — the keyboard path", () => {
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

  const primaryHint = () =>
    document.querySelector(".bench__primary")?.textContent ?? "";
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(window, { key, ...init });

  it("jumps benches with 1–5 and returns to the queue with Escape", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234");
    await waitFor(() => expect(openBench()).toBe("Look"));

    press("3");
    await waitFor(() => expect(openBench()).toBe("Card"));
    press("Escape");
    expect(await screen.findByText("queue")).toBeTruthy();
  });

  it("names what ⌘⏎ will do on the open workstation", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234/look");
    await waitFor(() => expect(openBench()).toBe("Look"));

    await waitFor(() => expect(primaryHint()).toContain("Save palette"));
  });

  /**
   * regression: #225 — the slot was claimed from a *passive* effect, so the label landed one commit
   * after the one that renders the bench, and React paints in between: opening Look painted a frame
   * reading "No primary action on this workstation" on a bench that has one, and ⌘⏎ pressed in that
   * window was a real dud. ADR 0044 §2 / curator-ui-ux §9.1 say the header *always* names the
   * action, not "always, one paint late".
   *
   * Same class as [#119](https://github.com/dylanleatham/Marquee/issues/119) — React paints rows
   * before it flushes effects — which is why this is guarded rather than only awaited.
   *
   * The MutationObserver is the whole point: it sees every DOM state the browser could have painted,
   * where an awaited assertion only ever sees the settled one. That gap is also what made the
   * assertion above flaky rather than red — `waitFor(openBench)` is satisfied by the first commit.
   */
  it.each([
    // Both registrants, and both ways a bench opens: the URL naming it, and the state defaulting
    // to it. The URL route was the reported one; Ship is the same mistake one component over.
    {
      bench: "Look",
      label: "Save palette",
      path: "/albums/abcd1234/look",
      asset: () => album(),
    },
    {
      bench: "Ship",
      label: "Mark sleeve tag written",
      path: "/albums/abcd1234",
      asset: () =>
        album({ roadie: { ...album().roadie, state: "awaiting_tag_write" } }),
    },
  ])(
    "never paints a frame claiming $bench has no primary action",
    async ({ bench, label, path, asset }) => {
      vi.mocked(api.album).mockResolvedValue(asset());
      const frames: string[] = [];
      const observer = new MutationObserver(() =>
        frames.push(`${openBench()} — ${primaryHint()}`),
      );
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      try {
        renderAt(path);
        await waitFor(() => expect(primaryHint()).toContain(label));
      } finally {
        observer.disconnect();
      }

      expect(
        frames.filter(
          (f) => f.startsWith(bench) && /no primary action/i.test(f),
        ),
      ).toEqual([]);
    },
  );

  it("says plainly that Video and Card have no primary action", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234/video");
    await waitFor(() => expect(openBench()).toBe("Video"));

    expect(primaryHint()).toMatch(/no primary action/i);
    press("Enter", { metaKey: true });
    // Inert is a decision, not an accident — nothing fires, and the header already said so.
    expect(api.editPalette).not.toHaveBeenCalled();
    expect(api.markTagWritten).not.toHaveBeenCalled();
  });

  it("runs Look's primary action — but only once there is something to save", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234/look");
    await waitFor(() => expect(openBench()).toBe("Look"));

    // Clean draft: the key must not fire, and the header carries the reason (§10).
    await waitFor(() => expect(primaryHint()).toMatch(/no unsaved changes/i));
    press("Enter", { metaKey: true });
    expect(api.editPalette).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Color 1 hex"), {
      target: { value: "#00FF00" },
    });
    await waitFor(() => expect(primaryHint()).not.toMatch(/no unsaved/i));
    press("Enter", { metaKey: true });
    await waitFor(() => expect(api.editPalette).toHaveBeenCalledTimes(1));
    // The *edited* draft, not the one captured when the bench mounted.
    expect(vi.mocked(api.editPalette).mock.calls[0]?.[1]).toEqual([
      { hex: "#00FF00", role: "primary" },
    ]);
  });

  it("runs Ship's primary action, following the order the bench works in", async () => {
    vi.mocked(api.album).mockResolvedValue(
      album({ roadie: { ...album().roadie, state: "awaiting_tag_write" } }),
    );
    renderAt("/albums/abcd1234");
    await waitFor(() => expect(openBench()).toBe("Ship"));

    await waitFor(() =>
      expect(primaryHint()).toContain("Mark sleeve tag written"),
    );
    press("Enter", { metaKey: true });
    await waitFor(() =>
      expect(api.markTagWritten).toHaveBeenCalledWith("abcd1234", "sleeve"),
    );
    expect(api.verifyAlbum).not.toHaveBeenCalled();
  });

  it("moves Ship's primary action on to verification once the sleeve is written", async () => {
    vi.mocked(api.album).mockResolvedValue(
      album({
        roadie: { ...album().roadie, state: "awaiting_verify" },
        tag: { sleeve: { written: true } },
      } as Partial<AlbumAsset>),
    );
    renderAt("/albums/abcd1234");
    await waitFor(() => expect(openBench()).toBe("Ship"));

    await waitFor(() =>
      expect(primaryHint()).toContain("Mark physically verified"),
    );
    press("Enter", { metaKey: true });
    await waitFor(() =>
      expect(api.verifyAlbum).toHaveBeenCalledWith("abcd1234"),
    );
  });

  it("refuses to verify before the sleeve tag is written, and says why", async () => {
    vi.mocked(api.album).mockResolvedValue(
      album({
        roadie: { ...album().roadie, state: "awaiting_review" },
        tag: { sleeve: { written: true } },
      } as Partial<AlbumAsset>),
    );
    renderAt("/albums/abcd1234/ship");
    await waitFor(() => expect(openBench()).toBe("Ship"));

    await waitFor(() =>
      expect(primaryHint()).toMatch(/write the sleeve tag first/i),
    );
    press("Enter", { metaKey: true });
    expect(api.verifyAlbum).not.toHaveBeenCalled();
  });

  it("never fires while the user is typing in a field", async () => {
    vi.mocked(api.album).mockResolvedValue(album());
    renderAt("/albums/abcd1234/look");
    await waitFor(() => expect(openBench()).toBe("Look"));

    const hex = screen.getByLabelText("Color 1 hex");
    fireEvent.change(hex, { target: { value: "#00FF00" } });
    await waitFor(() => expect(primaryHint()).not.toMatch(/no unsaved/i));

    fireEvent.keyDown(hex, { key: "Enter", metaKey: true, bubbles: true });
    fireEvent.keyDown(hex, { key: "2", bubbles: true });
    expect(api.editPalette).not.toHaveBeenCalled();
    expect(openBench()).toBe("Look");
  });
});
