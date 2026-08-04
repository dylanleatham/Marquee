// The collection sweep's progress panel (issue #234 / ADR 0051). What it has to get right is the
// end of a run: a sweep that stopped early must say so and say that re-running finishes the job,
// because "247 added" next to a silently truncated walk is a lie the user would act on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { DiscogsSyncReport, GenerationJob } from "../api";

const cancel = vi.fn();
const dismiss = vi.fn();
let state: {
  job: GenerationJob | null;
  error: string | null;
  unreachable: boolean;
};

vi.mock("../discogsSyncJob", () => ({
  useDiscogsSyncJob: () => state,
  cancelDiscogsSync: () => cancel(),
  dismissDiscogsSync: () => dismiss(),
}));

import { DiscogsSyncProgress } from "./DiscogsSyncProgress";

const report = (patch: Partial<DiscogsSyncReport> = {}): DiscogsSyncReport => ({
  total: 3,
  scanned: 3,
  added: 2,
  duplicate: 1,
  failed: 0,
  pages: 1,
  truncated: false,
  curatorIds: ["aaaaaaa1", "aaaaaaa2"],
  items: [],
  ...patch,
});

const job = (patch: Partial<GenerationJob> = {}): GenerationJob => ({
  id: "j1",
  kind: "discogsSync",
  status: "done",
  progress: { done: 3, total: 3 },
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:10.000Z",
  ...patch,
});

beforeEach(() => {
  state = { job: null, error: null, unreachable: false };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DiscogsSyncProgress", () => {
  it("renders nothing when no sweep has run", () => {
    const { container } = render(<DiscogsSyncProgress />);
    expect(container.innerHTML).toBe("");
  });

  it("counts records while running, and offers a stop", () => {
    state = {
      job: job({ status: "running", progress: { done: 12, total: 400 } }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);

    expect(screen.getByText("12 of 400 records")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancel).toHaveBeenCalled();
    // Dismissing mid-sweep would orphan a running job, so the ✕ isn't offered yet.
    expect(
      screen.queryByLabelText("Dismiss collection sync progress"),
    ).toBeNull();
  });

  it("summarizes a finished sweep", () => {
    state = {
      job: job({ result: { discogsSync: report() } }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);

    expect(screen.getByText("2 added · 1 already here")).toBeTruthy();
  });

  it("says a truncated sweep is finishable by running it again", () => {
    // The property ADR 0051 leans on — dedupe makes the sweep resumable — is only useful if the
    // screen tells you to use it.
    state = {
      job: job({
        result: {
          discogsSync: report({
            added: 100,
            duplicate: 0,
            scanned: 100,
            total: 400,
            truncated: true,
            truncatedReason: "fetch_failed",
          }),
        },
      }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);

    expect(screen.getByText(/run it again to pick up the rest/i)).toBeTruthy();
    expect(screen.getByText(/stopped answering partway/i)).toBeTruthy();
  });

  it("distinguishes the page cap from a cancel", () => {
    state = {
      job: job({
        result: {
          discogsSync: report({ truncated: true, truncatedReason: "page_cap" }),
        },
      }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);
    expect(screen.getByText(/page limit/i)).toBeTruthy();
  });

  it("lists what was added and what failed, but not the hundreds already here", () => {
    state = {
      job: job({
        result: {
          discogsSync: report({
            items: [
              {
                releaseId: 1,
                label: "Steely Dan — Aja",
                status: "added",
                curatorId: "a1",
              },
              {
                releaseId: 2,
                label: "Prince — Purple Rain",
                status: "duplicate",
                curatorId: "b2",
              },
              {
                releaseId: 3,
                label: "Nina Simone — Silk & Soul",
                status: "failed",
                error: "disk full",
              },
            ],
          }),
        },
      }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);

    expect(screen.getByText("Steely Dan — Aja")).toBeTruthy();
    expect(screen.getByText("Nina Simone — Silk & Soul")).toBeTruthy();
    expect(screen.getByText("disk full")).toBeTruthy();
    // A refresh of a 400-record collection is 399 "already here" rows; they'd bury the two that matter.
    expect(screen.queryByText("Prince — Purple Rain")).toBeNull();
  });

  it("reports a failed sweep with its error", () => {
    state = {
      job: job({ status: "failed", error: "Discogs is not configured" }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);
    expect(screen.getByText("Discogs is not configured")).toBeTruthy();
  });

  it("says when contact with Curator is lost, rather than freezing the bar", () => {
    state = {
      job: job({ status: "running", progress: { done: 5, total: 400 } }),
      error: null,
      unreachable: true,
    };
    render(<DiscogsSyncProgress />);
    expect(screen.getByText(/lost contact with curator/i)).toBeTruthy();
  });

  it("can be dismissed once the sweep is over", () => {
    state = {
      job: job({ result: { discogsSync: report() } }),
      error: null,
      unreachable: false,
    };
    render(<DiscogsSyncProgress />);

    fireEvent.click(screen.getByLabelText("Dismiss collection sync progress"));
    expect(dismiss).toHaveBeenCalled();
  });
});
