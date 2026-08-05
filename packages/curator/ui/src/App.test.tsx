// The shell (ADR 0052). What it wires together, and — just as deliberately — what it no longer
// binds: the whole global keyboard layer was withdrawn in favour of clarity, so a reappearing ⌘K is
// a regression, not a feature.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Inline in the factory: `vi.mock` is hoisted above every top-level binding in the file.
vi.mock("./api", () => ({
  api: {
    albums: vi.fn().mockResolvedValue({
      albums: [
        {
          curatorId: "6m3ntb8v",
          title: "Kind of Blue",
          artist: "Miles Davis",
          source: "spotify",
          state: "awaiting_review",
          artwork: null,
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
        },
      ],
    }),
    status: vi.fn().mockResolvedValue({
      paused: false,
      current: "6m3ntb8v",
      queueDepth: 1,
      activity: [
        {
          curatorId: "6m3ntb8v",
          from: "generating_palette",
          to: "awaiting_review",
          at: "2026-08-04T19:04:00.000Z",
        },
      ],
    }),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));
// Startup side effects with their own tests; they have nothing to say about the shell.
vi.mock("./batchJob", () => ({
  attachRunningBatch: vi.fn().mockResolvedValue(undefined),
  useBatchJob: () => ({ job: null, error: null, unreachable: false }),
  cancelBatch: vi.fn(),
  dismissBatch: vi.fn(),
}));
vi.mock("./discogsSyncJob", () => ({
  attachRunningDiscogsSync: vi.fn().mockResolvedValue(undefined),
  useDiscogsSyncJob: () => ({ job: null, error: null, unreachable: false }),
  cancelDiscogsSync: vi.fn(),
  dismissDiscogsSync: vi.fn(),
}));

import { App } from "./App";
import { resetRoadieLog } from "./roadieLog";

const renderApp = (at = "/") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <App />
    </MemoryRouter>,
  );

/** The record's tile in the grid. By role, because its title also appears in Roadie's log line. */
const tile = () => screen.findByRole("link", { name: /Kind of Blue/ });

beforeEach(() => {
  vi.clearAllMocks();
  resetRoadieLog();
});
afterEach(cleanup);

describe("App — the shell", () => {
  it("opens on the collection", async () => {
    renderApp();
    expect(await tile()).toBeTruthy();
    expect(screen.getByRole("link", { name: "COLLECTION" })).toBeTruthy();
  });

  it("feeds the masthead and the collection from one poll of the album list", async () => {
    const { api } = await import("./api");
    renderApp();
    await tile();
    // Two consumers, one request — the masthead's progress and the grid read the same fetch.
    expect(api.albums).toHaveBeenCalledTimes(1);
    expect(screen.getByText("OF 1 READY")).toBeTruthy();
  });

  it("turns Roadie's activity into a sentence in the log", async () => {
    renderApp();
    await waitFor(() =>
      expect(screen.getByText(/Pulled the lights from/)).toBeTruthy(),
    );
    expect(screen.getByText("ROADIE WORKING")).toBeTruthy();
  });
});

describe("App — the retired keyboard layer", () => {
  it("binds no global keydown handler at all", () => {
    const spy = vi.spyOn(window, "addEventListener");
    renderApp();
    expect(spy.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(
      0,
    );
    spy.mockRestore();
  });

  it("does not open a command palette on ⌘K, and offers no Jump button", async () => {
    renderApp();
    await tile();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/jump/i)).toBeNull();
  });

  it("does not navigate away when a letter is typed", async () => {
    renderApp();
    await tile();
    // `n` used to open the Add screen from anywhere, including mid-thought.
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByRole("link", { name: /Kind of Blue/ })).toBeTruthy();
  });
});
