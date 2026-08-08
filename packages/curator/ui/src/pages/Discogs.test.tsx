// The Discogs screen (ADR 0052) — a synced collection, not a picker.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Relative to the real clock, never a hardcoded date. This screen asks "what came in *today*", and
// the component reads the actual system clock — so a fixture pinned to 2026-08-06 passed on the day
// it was written and nowhere else. CI runs in UTC, which had already ticked over to the 7th, and the
// same tests would have gone red locally after midnight ([#244](https://github.com/dylanleatham/Marquee/issues/244)).
// Function declarations, not consts: `vi.mock` is hoisted above everything else in the file, and its
// factory calls these — a `const` arrow would still be in the temporal dead zone.
function nowIso(): string {
  return new Date().toISOString();
}
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

vi.mock("../api", () => ({
  api: {
    discogsSyncStatus: vi.fn().mockResolvedValue({
      enabled: true,
      intervalMs: 86400000,
      lastRunAt: nowIso(),
      lastJobId: null,
      lastError: null,
    }),
    discogsSettings: vi.fn().mockResolvedValue({
      configured: true,
      oauthConfigured: false,
      username: "dylan",
      autoSync: true,
      autoSyncIntervalMinutes: 1440,
    }),
    discogsCollection: vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pages: 1,
      perPage: 1,
      total: 312,
    }),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));
vi.mock("../discogsSyncJob", () => ({
  startDiscogsSync: vi.fn().mockResolvedValue(undefined),
}));

import { api, type AlbumSummary } from "../api";
import { startDiscogsSync } from "../discogsSyncJob";
import { Discogs } from "./Discogs";

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "discogs",
    createdAt: nowIso(),
    state: "awaiting_review",
    artwork: null,
    paletteColors: 3,
    hasVideo: false,
    year: 1977,
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
  album({ curatorId: "a1", title: "Pet Sounds" }),
  album({ curatorId: "a2", title: "Spiderland", state: "downloading_art" }),
  album({
    curatorId: "a3",
    title: "Untitled white label",
    state: "needs_manual",
    lastError: { message: "404", reason: "release_not_on_discogs" },
  }),
  // Not from Discogs, and from an earlier day — neither belongs on this screen's counts.
  album({
    curatorId: "b1",
    title: "Aja",
    source: "spotify",
    createdAt: daysAgoIso(5),
  }),
];

const show = (albums: AlbumSummary[] | null = ALBUMS) =>
  render(
    <MemoryRouter>
      <Discogs albums={albums} />
    </MemoryRouter>,
  );

// Restored, not just cleared: `clearAllMocks` keeps implementations, so one test's rejection would
// otherwise be every later test's too.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startDiscogsSync).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Discogs — the counts", () => {
  it("asks Discogs only for the one number the library doesn't hold", async () => {
    show();
    await waitFor(() => expect(screen.getByText("312")).toBeTruthy());
    // One row is enough — the response carries the total.
    expect(api.discogsCollection).toHaveBeenCalledWith(1, 1);
  });

  it("counts only Discogs records as being in Curator", async () => {
    show();
    await screen.findByText("312");
    const band = screen.getByRole("region", { name: /at a glance/i });
    expect(band.textContent).toContain("IN CURATOR");
    // Three from Discogs; the Spotify one doesn't count.
    expect(band.textContent).toMatch(/IN CURATOR3/);
  });

  it("shows an em dash rather than zero when Discogs won't answer", async () => {
    vi.mocked(api.discogsCollection).mockRejectedValue(new Error("429"));
    show();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't reach Discogs/)).toBeTruthy(),
    );
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("Discogs — what arrived", () => {
  it("says there is nothing to approve", async () => {
    show();
    expect(
      await screen.findByText(
        /already in your collection — nothing to approve/,
      ),
    ).toBeTruthy();
  });

  it("labels each arrival with the same words the collection uses", async () => {
    show();
    expect(await screen.findByText("Pet Sounds")).toBeTruthy();
    expect(screen.getByText("NEEDS A LOOK")).toBeTruthy();
    expect(screen.getByText("FINDING THE SLEEVE…")).toBeTruthy();
  });

  it("says so when nothing came in today", async () => {
    show([
      album({
        curatorId: "old",
        createdAt: daysAgoIso(36),
      }),
    ]);
    expect(await screen.findByText(/Nothing new today/)).toBeTruthy();
  });
});

describe("Discogs — the only real to-do", () => {
  it("lists what Roadie couldn't finish, and says it stays", async () => {
    show();
    expect(
      await screen.findByText(/ROADIE COULDN'T FINISH THESE · 1/),
    ).toBeTruthy();
    expect(screen.getByText(/never leave this list on their own/)).toBeTruthy();
    expect(
      screen.getByText(/the release is no longer on Discogs/),
    ).toBeTruthy();
  });

  it("sends you to the Add screen with the name already in it", async () => {
    show();
    const link = await screen.findByRole("link", { name: "SEARCH BY HAND" });
    expect(link.getAttribute("href")).toBe("/add?q=Untitled%20white%20label");
  });

  it("skips a row for this session without pretending it is resolved", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "SKIP" }));
    await waitFor(() =>
      expect(screen.queryByText(/COULDN'T FINISH/)).toBeNull(),
    );
  });
});

describe("Discogs — the rest", () => {
  it("offers a sync now for when you don't want to wait", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "SYNC NOW" }));
    await waitFor(() => expect(startDiscogsSync).toHaveBeenCalled());
  });

  it("says so when the sync won't start, rather than settling back as if nothing happened", async () => {
    vi.mocked(startDiscogsSync).mockRejectedValue(
      new Error("Discogs said 429"),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "SYNC NOW" }));
    expect(await screen.findByText(/Discogs said 429/)).toBeTruthy();
  });

  it("says when it last ran and whether it runs itself", async () => {
    show();
    expect(
      await screen.findByText(/today, \d{2}:\d{2} · automatic/),
    ).toBeTruthy();
  });

  it("explains the two behaviours that would otherwise surprise you", async () => {
    show();
    expect(
      await screen.findByText(/Multiple pressings of the same record collapse/),
    ).toBeTruthy();
  });

  it("points at Settings when Discogs isn't connected at all", async () => {
    vi.mocked(api.discogsSettings).mockResolvedValue({
      configured: false,
      oauthConfigured: false,
      username: null,
      autoSync: false,
      autoSyncIntervalMinutes: 1440,
    });
    show();
    expect(
      await screen.findByText(/isn't connected to Discogs yet/),
    ).toBeTruthy();
  });
});
