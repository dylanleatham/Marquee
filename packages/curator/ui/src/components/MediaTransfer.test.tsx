// The transfer panel (issue #177). Its whole reason to exist is that a transfer can run for an hour
// over a poor link — so what matters is that it says something true the whole time, and that a
// finished or absent transfer says nothing at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MediaTransfer, formatBytes, etaSeconds } from "./MediaTransfer";
import { api } from "../api";

const job = (over: Record<string, unknown> = {}) => ({
  id: "job1",
  kind: "mediaTransfer" as const,
  curatorId: "abc12345",
  status: "running" as const,
  progress: { done: 50 * 1024 * 1024, total: 200 * 1024 * 1024 },
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  ...over,
});

describe("formatBytes", () => {
  it("scales so the number stays readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(64 * 1024)).toBe("64 KB");
    expect(formatBytes(239_449_861)).toBe("228.4 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});

describe("etaSeconds", () => {
  /**
   * An estimate from almost no data is worse than none: the user believes it, and a wrong "2 minutes
   * left" on a 90-minute transfer is how a feature loses trust.
   */
  it("says nothing until there is enough to go on", () => {
    expect(etaSeconds(1000, 1_000_000, 500)).toBeNull(); // too early
    expect(etaSeconds(0, 1_000_000, 10_000)).toBeNull(); // nothing sent yet
    expect(etaSeconds(1_000_000, 1_000_000, 10_000)).toBeNull(); // already done
  });

  it("extrapolates from the rate actually achieved", () => {
    // 1 MB in 10s → 9 MB left at 0.1 MB/s → 90s.
    expect(etaSeconds(1_000_000, 10_000_000, 10_000)).toBe(90);
  });
});

describe("MediaTransfer", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when there is no transfer", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    const { container } = render(<MediaTransfer curatorId="abc12345" />);
    await waitFor(() => expect(api.albumJobs).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing once the transfer is done — a quiet success needs no UI", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({
      jobs: [job({ status: "done" })],
    });
    const { container } = render(<MediaTransfer curatorId="abc12345" />);
    await waitFor(() => expect(api.albumJobs).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("shows progress as bytes and a percentage, not a bare bar", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [job()] });
    render(<MediaTransfer curatorId="abc12345" />);

    // 50 of 200 MB → 25%. The numbers carry the meaning; the bar is decoration (ui-ux §3.4).
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("25%");
    expect(status.textContent).toContain("50.0 MB");
    expect(status.textContent).toContain("200.0 MB");
  });

  it("says the work continues in the background, because that is the point", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [job()] });
    render(<MediaTransfer curatorId="abc12345" />);
    expect((await screen.findByRole("status")).textContent).toMatch(
      /keep working/i,
    );
  });

  it("offers a way to stop a transfer that is taking too long", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [job()] });
    const cancel = vi.spyOn(api, "cancelJob").mockResolvedValue(job() as never);
    render(<MediaTransfer curatorId="abc12345" />);

    (await screen.findByRole("button", { name: /stop/i })).click();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("job1"));
  });

  /**
   * A failed transfer must say what still works. The album's lights are unaffected — only the screen
   * is — and a user who doesn't know that will assume the whole album is broken.
   */
  it("explains a failure, including what still works", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({
      jobs: [job({ status: "failed", error: "Backdrop unreachable" })],
    });
    render(<MediaTransfer curatorId="abc12345" />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Backdrop unreachable");
    expect(status.textContent).toMatch(/lights still work/i);
  });

  it("survives a polling failure rather than taking the page down", async () => {
    vi.spyOn(api, "albumJobs").mockRejectedValue(new Error("network"));
    const { container } = render(<MediaTransfer curatorId="abc12345" />);
    await waitFor(() => expect(api.albumJobs).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
