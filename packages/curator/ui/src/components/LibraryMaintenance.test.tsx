// Settings → Library (issue #104). The property worth pinning is the guard on `force`: it is the
// only control in Curator that discards hand-edited palettes, across the whole collection, and
// curator-spec §12 says a hand-edit is never overwritten without explicit user action.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

vi.mock("../api", () => ({
  api: {
    job: vi.fn(),
    cancelJob: vi.fn(),
    libraryJobs: vi.fn(),
    regeneratePalettes: vi.fn(),
    backfillSpotifyMatches: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

import { api, type GenerationJob } from "../api";
import { LibraryMaintenance } from "./LibraryMaintenance";
import { ConfirmProvider } from "./Confirm";
import { resetBatchJob } from "../batchJob";
import { resetSpotifyBackfillJob } from "../spotifyBackfillJob";

const running: GenerationJob = {
  id: "job-1",
  kind: "paletteBatch",
  status: "running",
  progress: { done: 0, total: 4 },
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

const show = () =>
  render(
    <ConfirmProvider>
      <LibraryMaintenance />
    </ConfirmProvider>,
  );

const forceBox = () =>
  screen.getByLabelText(/include hand-edited/i) as HTMLInputElement;
const runButton = () => screen.getByRole("button", { name: /regenerate all/i });

beforeEach(() => {
  resetBatchJob();
  resetSpotifyBackfillJob();
  vi.mocked(api.regeneratePalettes).mockResolvedValue(running);
  vi.mocked(api.backfillSpotifyMatches).mockResolvedValue({
    ...running,
    kind: "spotifyBackfill",
  });
  vi.mocked(api.job).mockResolvedValue(running);
});

afterEach(() => {
  resetBatchJob();
  resetSpotifyBackfillJob();
  cleanup();
  vi.clearAllMocks();
});

describe("LibraryMaintenance", () => {
  it("starts a sweep that leaves hand-edited palettes alone", async () => {
    show();
    fireEvent.click(runButton());
    await waitFor(() =>
      expect(api.regeneratePalettes).toHaveBeenCalledWith(false),
    );
  });

  it("asks before discarding hand-edits, and doesn't start if you decline", async () => {
    show();
    fireEvent.click(forceBox());
    fireEvent.click(runButton());

    await screen.findByText("Discard every hand-edited palette?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(api.regeneratePalettes).not.toHaveBeenCalled());
  });

  it("forces once you confirm", async () => {
    show();
    fireEvent.click(forceBox());
    fireEvent.click(runButton());

    fireEvent.click(
      await screen.findByRole("button", { name: "Regenerate everything" }),
    );
    await waitFor(() =>
      expect(api.regeneratePalettes).toHaveBeenCalledWith(true),
    );
  });

  it("won't start a second sweep while one is running", async () => {
    show();
    fireEvent.click(runButton());

    // The server dedups anyway (ADR 0029), but a live button that does nothing reads as broken.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /regenerating/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(forceBox().disabled).toBe(true);
  });
});

/**
 * The Spotify backfill (ADR 0059). Unlike the palette sweep beside it this needs no confirm — it
 * only ever *adds* an identity, never overwrites or discards one — so the property to pin is that it
 * starts, disables itself while running, and doesn't put a destructive-sounding gate in the way.
 */
describe("LibraryMaintenance — Spotify backfill", () => {
  const backfillButton = () =>
    screen.getByRole("button", { name: /Match Discogs records to Spotify/i });

  it("starts the backfill on click", async () => {
    show();
    fireEvent.click(backfillButton());
    await waitFor(() =>
      expect(api.backfillSpotifyMatches).toHaveBeenCalledTimes(1),
    );
  });

  it("asks for no confirmation — nothing here is destructive", async () => {
    show();
    fireEvent.click(backfillButton());
    await waitFor(() =>
      expect(api.backfillSpotifyMatches).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables itself and says so while a run is going", async () => {
    show();
    fireEvent.click(backfillButton());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Matching…/i }) as HTMLButtonElement,
      ).toBeTruthy(),
    );
    expect(
      (screen.getByRole("button", { name: /Matching…/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  /** Two independent sweeps in one panel: starting one must not disable the other. */
  it("leaves the palette sweep's button alone", async () => {
    show();
    fireEvent.click(backfillButton());
    await waitFor(() =>
      expect(api.backfillSpotifyMatches).toHaveBeenCalledTimes(1),
    );
    expect(
      (
        screen.getByRole("button", {
          name: /Regenerate all palettes/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("explains that only an exact match is allowed to play", () => {
    show();
    expect(screen.getByText(/exact/)).toBeTruthy();
    expect(
      screen.getByText(/near match keeps its cover and stays silent/i),
    ).toBeTruthy();
  });
});
