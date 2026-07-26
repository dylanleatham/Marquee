// The batch progress panel and the store behind it (issue #104). Two properties are worth pinning:
// a running sweep is reattachable after a reload — the whole reason this is a job and not an SSE
// stream (ADR 0029) — and every outcome row says in words what happened, since a skip and a failure
// mean very different things to the person reading them.
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
  },
  ApiError: class ApiError extends Error {},
}));

import { api, type GenerationJob } from "../api";
import { BatchProgress } from "./BatchProgress";
import {
  startPaletteRegen,
  attachRunningBatch,
  cancelBatch,
  dismissBatch,
  resetBatchJob,
  POLL_MS,
} from "../batchJob";

const job = (patch: Partial<GenerationJob> = {}): GenerationJob => ({
  id: "job-1",
  kind: "paletteBatch",
  status: "running",
  progress: { done: 2, total: 5 },
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:01.000Z",
  ...patch,
});

const finished = (): GenerationJob =>
  job({
    status: "done",
    progress: { done: 3, total: 3 },
    result: {
      paletteBatch: {
        total: 3,
        regenerated: 1,
        skipped: 1,
        failed: 1,
        items: [
          {
            curatorId: "aaa",
            label: "Miles Davis — Kind of Blue",
            status: "regenerated",
          },
          {
            curatorId: "bbb",
            label: "Prince — Purple Rain",
            status: "skipped_hand_edited",
          },
          {
            curatorId: "ccc",
            label: "Nina Simone — Silk & Soul",
            status: "failed",
            error: "cover unreadable",
          },
        ],
      },
    },
  });

beforeEach(() => {
  resetBatchJob();
  vi.mocked(api.regeneratePalettes).mockResolvedValue(job());
  vi.mocked(api.job).mockResolvedValue(job());
  vi.mocked(api.cancelJob).mockResolvedValue(job({ status: "cancelled" }));
  vi.mocked(api.libraryJobs).mockResolvedValue({ jobs: [] });
});

afterEach(() => {
  resetBatchJob();
  cleanup();
  vi.clearAllMocks();
});

describe("BatchProgress", () => {
  it("renders nothing until a sweep exists", () => {
    const { container } = render(<BatchProgress />);
    expect(container.innerHTML).toBe("");
  });

  it("shows progress and a way to stop while a sweep runs", async () => {
    render(<BatchProgress />);
    await startPaletteRegen();

    await screen.findByText("2 of 5 albums");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
    // No dismiss while work is in flight — closing the panel would hide the only stop button.
    expect(screen.queryByLabelText("Dismiss batch progress")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    await screen.findByText(/Cancelled after 2 of 5/);
    // The point of the wording: cancelling doesn't undo the palettes already written.
    expect(screen.getByText(/already regenerated are saved/)).toBeTruthy();
  });

  it("names every outcome in words, not by colour alone", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(finished());
    render(<BatchProgress />);
    await startPaletteRegen();

    await screen.findByText("1 regenerated · 1 skipped · 1 failed");
    expect(screen.getByText("Regenerated")).toBeTruthy();
    expect(screen.getByText("Skipped — hand-edited")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("cover unreadable")).toBeTruthy();
  });

  it("can be dismissed once the sweep is over", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(finished());
    const { container } = render(<BatchProgress />);
    await startPaletteRegen();

    fireEvent.click(await screen.findByLabelText("Dismiss batch progress"));
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("surfaces a failure to start, which no job can report for itself", async () => {
    vi.mocked(api.regeneratePalettes).mockRejectedValue(
      new Error("palette generator isn't available"),
    );
    render(<BatchProgress />);
    await startPaletteRegen();
    await screen.findByText("palette generator isn't available");
  });
});

describe("attachRunningBatch", () => {
  it("picks a sweep back up after a reload", async () => {
    vi.mocked(api.libraryJobs).mockResolvedValue({ jobs: [job()] });
    render(<BatchProgress />);

    await attachRunningBatch();

    await screen.findByText("2 of 5 albums");
    expect(api.libraryJobs).toHaveBeenCalledWith("paletteBatch");
  });

  it("ignores a sweep that already finished — there is nothing to watch", async () => {
    vi.mocked(api.libraryJobs).mockResolvedValue({ jobs: [finished()] });
    const { container } = render(<BatchProgress />);

    await attachRunningBatch();

    expect(container.innerHTML).toBe("");
  });

  it("stays quiet when Curator can't answer", async () => {
    vi.mocked(api.libraryJobs).mockRejectedValue(new Error("offline"));
    const { container } = render(<BatchProgress />);

    await attachRunningBatch();

    expect(container.innerHTML).toBe("");
  });
});

describe("batchJob store", () => {
  it("cancel and dismiss are no-ops with no sweep running", async () => {
    await cancelBatch();
    dismissBatch();
    expect(api.cancelJob).not.toHaveBeenCalled();
  });
});

/**
 * The poll loop is what makes the panel live, and both of its failure modes are silent: a loop that
 * stops early leaves a sweep running with a frozen bar, and one that never stops keeps hitting the
 * server forever after the job is over. Neither shows up in the rendering tests above, so drive the
 * clock directly.
 */
describe("batchJob polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Advance one poll interval and let the awaited fetch settle. */
  const tick = async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  };

  it("keeps polling while the job runs, and re-renders each answer", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(job());
    vi.mocked(api.job).mockResolvedValue(
      job({ progress: { done: 4, total: 5 } }),
    );
    render(<BatchProgress />);
    await startPaletteRegen();

    await tick();
    expect(api.job).toHaveBeenCalledTimes(1);
    expect(screen.getByText("4 of 5 albums")).toBeTruthy();

    await tick();
    expect(api.job).toHaveBeenCalledTimes(2);
  });

  it("stops polling once the job reaches a terminal state", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(job());
    vi.mocked(api.job).mockResolvedValue(finished());
    render(<BatchProgress />);
    await startPaletteRegen();

    await tick();
    expect(api.job).toHaveBeenCalledTimes(1);

    // Several more intervals with no further requests — the loop is genuinely stopped, not slowed.
    await tick();
    await tick();
    expect(api.job).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("1 regenerated · 1 skipped · 1 failed"),
    ).toBeTruthy();
  });

  it("survives a transient poll failure instead of going quiet", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(job());
    vi.mocked(api.job)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(finished());
    render(<BatchProgress />);
    await startPaletteRegen();

    await tick();
    await tick();
    // A blip must not end the loop — the sweep is still running on the server either way.
    expect(api.job).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("1 regenerated · 1 skipped · 1 failed"),
    ).toBeTruthy();
  });

  it("stops polling when the panel is dismissed", async () => {
    vi.mocked(api.regeneratePalettes).mockResolvedValue(finished());
    render(<BatchProgress />);
    await startPaletteRegen();

    dismissBatch();
    await tick();
    await tick();
    expect(api.job).not.toHaveBeenCalled();
  });
});
