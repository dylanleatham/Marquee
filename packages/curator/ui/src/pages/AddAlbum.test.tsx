// The Paste URI tab (issue #104). The behaviour that matters is what happens when a paste is
// *partly* good — the common case with twenty lines. The screen used to fire one request per line
// and could only report a pile of error strings; now it submits one batch and reports per line, so
// the assertions here are about the report surviving and staying readable rather than the screen
// navigating away with the outcome unseen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api", () => ({
  api: {
    addAlbumsBatch: vi.fn(),
    searchSpotify: vi.fn(),
    discogsCollection: vi.fn(),
    addManual: vi.fn(),
    addSpotify: vi.fn(),
    addDiscogs: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));

const startDiscogsSync = vi.fn().mockResolvedValue(undefined);
let syncJob: { job: unknown; error: null; unreachable: boolean } = {
  job: null,
  error: null,
  unreachable: false,
};
vi.mock("../discogsSyncJob", () => ({
  startDiscogsSync: () => startDiscogsSync(),
  useDiscogsSyncJob: () => syncJob,
}));

import { api, type BatchAddReport } from "../api";
import { AddAlbum } from "./AddAlbum";

const report = (patch: Partial<BatchAddReport> = {}): BatchAddReport => ({
  added: 0,
  duplicate: 0,
  invalid: 0,
  failed: 0,
  curatorIds: [],
  items: [],
  ...patch,
});

/** Render the page and switch to the Paste URI tab, which is where all of this lives. */
function pasteTab() {
  render(
    <MemoryRouter>
      <AddAlbum />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Paste URI" }));
  return screen.getByRole("textbox");
}

const addAll = () =>
  fireEvent.click(screen.getByRole("button", { name: "Add all" }));

beforeEach(() => {
  vi.mocked(api.addAlbumsBatch).mockResolvedValue(report());
  syncJob = { job: null, error: null, unreachable: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddAlbum — Paste URI", () => {
  it("submits every non-blank line as one batch", async () => {
    const box = pasteTab();
    fireEvent.change(box, {
      target: { value: " spotify:album:AAA \n\n spotify:album:BBB \n" },
    });
    addAll();

    await waitFor(() =>
      expect(api.addAlbumsBatch).toHaveBeenCalledWith([
        "spotify:album:AAA",
        "spotify:album:BBB",
      ]),
    );
  });

  it("does nothing at all on an empty box", () => {
    pasteTab();
    addAll();
    expect(api.addAlbumsBatch).not.toHaveBeenCalled();
  });

  it("leaves on a clean sweep — that's what you asked for", async () => {
    vi.mocked(api.addAlbumsBatch).mockResolvedValue(
      report({ added: 2, curatorIds: ["aaaaaaa1", "aaaaaaa2"] }),
    );
    const box = pasteTab();
    fireEvent.change(box, {
      target: { value: "spotify:album:AAA\nspotify:album:BBB" },
    });
    addAll();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("stays put on a partial success and names the line that failed", async () => {
    vi.mocked(api.addAlbumsBatch).mockResolvedValue(
      report({
        added: 1,
        duplicate: 1,
        invalid: 1,
        curatorIds: ["aaaaaaa1"],
        items: [
          {
            index: 0,
            input: "spotify:album:AAA",
            status: "added",
            curatorId: "aaaaaaa1",
          },
          {
            index: 1,
            input: "spotify:album:BBB",
            status: "duplicate",
            curatorId: "bbbbbbb2",
          },
          { index: 2, input: "junk", status: "invalid" },
        ],
      }),
    );
    const box = pasteTab();
    fireEvent.change(box, {
      target: { value: "spotify:album:AAA\nspotify:album:BBB\njunk" },
    });
    addAll();

    await screen.findByText("1 added · 1 already added · 1 not a URI");
    // Line numbers are 1-based, matching what the person is looking at in their paste.
    expect(screen.getByText("Line 2")).toBeTruthy();
    expect(screen.getByText("Line 3")).toBeTruthy();
    // Successful lines aren't listed — the interesting rows would be lost in twenty "Added"s.
    expect(screen.queryByText("Line 1")).toBeNull();
    // Navigating away would discard the report, so it has to be the user's move.
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Go to queue" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("reports a request that failed outright", async () => {
    vi.mocked(api.addAlbumsBatch).mockRejectedValue(
      new Error("Spotify not configured"),
    );
    const box = pasteTab();
    fireEvent.change(box, { target: { value: "spotify:album:AAA" } });
    addAll();

    await screen.findByText("Spotify not configured");
  });
});

// The whole-collection sweep (issue #234 / ADR 0051). One button covers both the first import and
// every later refresh, so what matters is that it's reachable, it starts the sweep, and it reflects
// a sweep already in flight rather than offering to start a second.
describe("AddAlbum — Discogs collection sync", () => {
  /** Render and switch to the Discogs tab. */
  function discogsTab() {
    vi.mocked(api.discogsCollection).mockResolvedValue({
      items: [],
      page: 1,
      pages: 1,
      perPage: 50,
      total: 0,
    });
    render(
      <MemoryRouter>
        <AddAlbum />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discogs collection" }));
  }

  it("starts the sweep when the button is pressed", async () => {
    discogsTab();

    fireEvent.click(
      await screen.findByRole("button", { name: "Sync collection" }),
    );

    await waitFor(() => expect(startDiscogsSync).toHaveBeenCalledTimes(1));
  });

  it("says plainly that it costs no AI credits", async () => {
    // The reason the user asked for this feature; it belongs on the button, not only in an ADR.
    discogsTab();
    expect(await screen.findByText(/no AI\s+credits are spent/i)).toBeTruthy();
  });

  it("shows a sweep already running instead of offering to start another", async () => {
    syncJob = {
      job: {
        id: "j1",
        kind: "discogsSync",
        status: "running",
        progress: { done: 12, total: 400 },
        createdAt: "",
        updatedAt: "",
      },
      error: null,
      unreachable: false,
    };
    discogsTab();

    const button = await screen.findByRole("button", { name: "Syncing…" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("still offers the per-row add, for when you only want one record", async () => {
    // The sweep is the headline, not a replacement: adding a single record stays possible.
    vi.mocked(api.discogsCollection).mockResolvedValue({
      items: [
        {
          releaseId: 42,
          discogsUri: "discogs:release:42",
          title: "Aja",
          artist: "Steely Dan",
          year: 1977,
          genres: [],
        },
      ],
      page: 1,
      pages: 1,
      perPage: 50,
      total: 1,
    });
    render(
      <MemoryRouter>
        <AddAlbum />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discogs collection" }));

    expect(await screen.findByText("Aja")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Roadie" })).toBeTruthy();
  });
});
