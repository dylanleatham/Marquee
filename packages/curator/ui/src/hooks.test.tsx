import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePoll, useGenerationJob, usePending } from "./hooks";
import { api, type GenerationJob, type JobKind } from "./api";

// Flush the microtasks an async fetcher resolves on (fake timers don't fake promises).
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("usePoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Reset visibility for the next test.
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
  });

  it("fetches on mount and once per interval", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("pauses while the tab is hidden and resumes (with an immediate fetch) on return", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1); // no polling while hidden

    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); // immediate fetch on return
  });

  it("refresh() triggers an immediate refetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("ok");
    const { result } = renderHook(() => usePoll(fetcher, 1_000_000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces a fetch failure as error, not a throw", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(result.current.error).toBe("boom");
    expect(result.current.data).toBeNull();
  });
});

describe("useGenerationJob", () => {
  afterEach(() => vi.restoreAllMocks());

  const job = (
    over: Partial<GenerationJob> = {},
    kind: JobKind = "video",
  ): GenerationJob => ({
    id: "job-1",
    kind,
    curatorId: "abcd1234",
    status: "running",
    progress: { done: 0, total: 3 },
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    ...over,
  });

  it("starts a job, polls to done, and calls onDone", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "job").mockResolvedValue(job({ status: "done" }));
    const starter = vi.fn().mockResolvedValue(job({ status: "running" }));
    const onDone = vi.fn();

    const { result } = renderHook(() =>
      useGenerationJob("abcd1234", "video", starter, onDone),
    );
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(starter).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed job's error", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "job").mockResolvedValue(
      job({ status: "failed", error: "upstream boom" }),
    );
    const starter = vi.fn().mockResolvedValue(job({ status: "running" }));

    const { result } = renderHook(() =>
      useGenerationJob("abcd1234", "video", starter, vi.fn()),
    );
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toBe("upstream boom");
  });

  it("surfaces a failure when the start request itself rejects", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    const starter = vi.fn().mockRejectedValue(new Error("503 not configured"));

    const { result } = renderHook(() =>
      useGenerationJob("abcd1234", "video", starter, vi.fn()),
    );
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toBe("503 not configured");
  });

  it("re-attaches to a running job on mount (survives a reload)", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({
      jobs: [job({ status: "running" })],
    });
    vi.spyOn(api, "job").mockResolvedValue(job({ status: "done" }));
    const onDone = vi.fn();

    renderHook(() =>
      useGenerationJob("abcd1234", "video", vi.fn(), onDone),
    );
    // No start() call — the mount re-attach adopts the running job and polls it to completion.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("makes no requests when disabled (generation off)", async () => {
    const albumJobs = vi
      .spyOn(api, "albumJobs")
      .mockResolvedValue({ jobs: [] });
    renderHook(() =>
      useGenerationJob("abcd1234", "video", vi.fn(), vi.fn(), false),
    );
    await flush();
    expect(albumJobs).not.toHaveBeenCalled();
  });
});

describe("usePending", () => {
  it("flips pending true for the life of the wrapped action, then back to false", async () => {
    let release!: () => void;
    const { result } = renderHook(() => usePending());
    expect(result.current[0]).toBe(false);

    let done!: Promise<void>;
    act(() => {
      done = result.current[1](() => new Promise<void>((r) => (release = r)));
    });
    await waitFor(() => expect(result.current[0]).toBe(true));

    await act(async () => {
      release();
      await done;
    });
    expect(result.current[0]).toBe(false);
  });

  it("clears pending even when the wrapped action rejects", async () => {
    const { result } = renderHook(() => usePending());
    await act(async () => {
      await result.current[1](() => Promise.reject(new Error("boom"))).catch(
        () => {},
      );
    });
    expect(result.current[0]).toBe(false);
  });
});
