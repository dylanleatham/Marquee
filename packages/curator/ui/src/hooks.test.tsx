import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  usePoll,
  useGenerationJob,
  usePending,
  useVisibleCycle,
  useUpload,
} from "./hooks";
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

  it("refetches at once when the resetKey changes, without waiting out the interval", async () => {
    // React Router reuses a component when only a route param changes, so `/room/a` → `/room/b`
    // never remounts: the fetcher ref updates silently and the previous record stays on screen for a
    // whole interval while the room already plays the new one.
    const fetcher = vi.fn().mockResolvedValue("ok");
    const { rerender } = renderHook(
      ({ id }: { id: string }) => usePoll(() => fetcher(id), 5000, id),
      { initialProps: { id: "a" } },
    );
    await flush();
    expect(fetcher).toHaveBeenCalledWith("a");
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ id: "b" });
    await flush();
    expect(fetcher).toHaveBeenCalledWith("b");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not restart when the resetKey is unchanged", async () => {
    // Otherwise every re-render — and this polls, so there are many — would refetch.
    const fetcher = vi.fn().mockResolvedValue("ok");
    const { rerender } = renderHook(() => usePoll(fetcher, 5000, "a"));
    await flush();
    rerender();
    rerender();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
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

  it("drops interval ticks that land on a request still in flight", async () => {
    // The System screen fans out to four services, each probe bounded at 5s, and it is open exactly
    // when the runtime is down — so a request takes about as long as the interval. Without this,
    // every tick stacks another fan-out on a host that is already not answering.
    let settle: (v: string) => void = () => {};
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<string>((r) => (settle = r)));
    renderHook(() => usePoll(fetcher, 1000));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3500); // three ticks, all while the first is still open
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle("ok");
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("still honours a refresh() made during a request, once that one lands", async () => {
    // A refresh usually follows a mutation, so joining the in-flight request would show the state
    // from before it — the one case where dropping the call is the wrong answer.
    let settle: (v: string) => void = () => {};
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<string>((r) => (settle = r)));
    const { result } = renderHook(() => usePoll(fetcher, 1_000_000));
    await flush();

    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle("ok");
      await Promise.resolve();
      await Promise.resolve();
    });
    // One follow-up, not two: both refreshes would have read the same state.
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

    renderHook(() => useGenerationJob("abcd1234", "video", vi.fn(), onDone));
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

  // Issue #57: cancel() optimistically flips to cancelled and POSTs the cancel for the polled job.
  it("cancel() marks the job cancelled and calls api.cancelJob for it", async () => {
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "job").mockResolvedValue(job({ status: "running" }));
    const cancelJob = vi
      .spyOn(api, "cancelJob")
      .mockResolvedValue(job({ status: "cancelled" }));
    const starter = vi.fn().mockResolvedValue(job({ status: "running" }));

    const { result } = renderHook(() =>
      useGenerationJob("abcd1234", "video", starter, vi.fn()),
    );
    await act(async () => result.current.start());
    // Wait until the job is being polled (adopt has set the id cancel() targets).
    await waitFor(() => expect(api.job).toHaveBeenCalled());

    await act(async () => result.current.cancel());
    expect(result.current.status).toBe("cancelled");
    expect(cancelJob).toHaveBeenCalledWith("job-1");
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

describe("useVisibleCycle", () => {
  /** Minimal IntersectionObserver stand-in — jsdom has none. Exposes the last instance's callback. */
  class FakeIO {
    static last: FakeIO | undefined;
    readonly observed: Element[] = [];
    disconnected = false;
    constructor(private readonly cb: IntersectionObserverCallback) {
      FakeIO.last = this;
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    /** Drive the callback the way a real observer would. */
    emit(isIntersecting: boolean) {
      this.cb(
        [{ isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }

  const setHidden = (value: boolean) =>
    Object.defineProperty(document, "hidden", { value, configurable: true });

  beforeEach(() => {
    vi.useFakeTimers();
    FakeIO.last = undefined;
    vi.stubGlobal("IntersectionObserver", FakeIO);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setHidden(false);
  });

  /** Attach the ref to a real node, as a component rendering the hook would. */
  const attach = (ref: (node: Element | null) => void) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => ref(el));
    return el;
  };

  it("advances one step per holdMs and wraps at the end", () => {
    const { result } = renderHook(() => useVisibleCycle(3, 1000));
    expect(result.current.index).toBe(0);

    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.index).toBe(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current.index).toBe(0);
  });

  it("does not tick when there is nothing to cycle through", () => {
    const { result } = renderHook(() => useVisibleCycle(1, 1000));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.index).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops while the tab is hidden and resumes on return", () => {
    const { result } = renderHook(() => useVisibleCycle(3, 1000));
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.index).toBe(1);

    setHidden(true);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.index).toBe(1); // frozen — nobody is looking

    setHidden(false);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.index).toBe(2);
  });

  it("stops while the observed element is off screen and resumes on screen", () => {
    const { result } = renderHook(() => useVisibleCycle(3, 1000));
    attach(result.current.ref);

    act(() => FakeIO.last!.emit(false));
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.index).toBe(0);

    act(() => FakeIO.last!.emit(true));
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.index).toBe(1);
  });

  it("keeps cycling when the environment has no IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { result } = renderHook(() => useVisibleCycle(3, 1000));
    attach(result.current.ref);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.index).toBe(1);
  });

  it("clamps the index when the palette shrinks under it", () => {
    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => useVisibleCycle(n, 1000),
      { initialProps: { n: 5 } },
    );
    act(() => void vi.advanceTimersByTime(4000));
    expect(result.current.index).toBe(4);

    rerender({ n: 2 });
    expect(result.current.index).toBeLessThan(2);
  });

  it("tears down the timer, the observer, and the listener on unmount", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { result, unmount } = renderHook(() => useVisibleCycle(3, 1000));
    attach(result.current.ref);
    const io = FakeIO.last!;

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(io.disconnected).toBe(true);
    expect(remove).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });
});

/**
 * The state behind the upload strip (issue #284). Two panels take files, and they both used to show
 * nothing at all while one was moving — one hook so they can't drift into two answers for it.
 */
describe("useUpload", () => {
  const file = (name: string, size: number) => {
    const f = new File(["x"], name);
    Object.defineProperty(f, "size", { value: size });
    return f;
  };

  it("names the file and its size before a single byte is reported", async () => {
    const { result } = renderHook(() => useUpload());
    act(
      () =>
        void result.current.send(
          file("clip.mp4", 2048),
          () => new Promise(() => {}),
        ),
    );
    expect(result.current.inFlight).toMatchObject({
      name: "clip.mp4",
      sent: 0,
      total: 2048,
    });
  });

  it("tracks the bytes the poster reports", async () => {
    const { result } = renderHook(() => useUpload());
    let report!: (sent: number, total: number) => void;
    act(() => {
      void result.current.send(file("clip.mp4", 2048), (opts) => {
        report = (sent, total) => opts.onProgress?.(sent, total);
        return new Promise(() => {});
      });
    });
    act(() => report(512, 2048));
    expect(result.current.inFlight).toMatchObject({ sent: 512, total: 2048 });
  });

  it("keeps the file's own size when the browser won't say how big the body is", async () => {
    // A total of 0 means "unknown", not "empty" — taking it literally would divide the strip by zero.
    const { result } = renderHook(() => useUpload());
    let report!: (sent: number, total: number) => void;
    act(() => {
      void result.current.send(file("clip.mp4", 2048), (opts) => {
        report = (sent, total) => opts.onProgress?.(sent, total);
        return new Promise(() => {});
      });
    });
    act(() => report(512, 0));
    expect(result.current.inFlight).toMatchObject({ sent: 512, total: 2048 });
  });

  it("clears when the upload lands, and hands back what the poster returned", async () => {
    const { result } = renderHook(() => useUpload());
    let landed: unknown;
    await act(async () => {
      landed = await result.current.send(file("clip.mp4", 2048), () =>
        Promise.resolve({ state: "awaiting_preview" }),
      );
    });
    expect(landed).toEqual({ state: "awaiting_preview" });
    expect(result.current.inFlight).toBeNull();
  });

  it("clears when the upload fails, and lets the failure through to the caller", async () => {
    // The strip must not outlive the transfer: a panel stuck on "Sending…" after a refused upload is
    // the same lie in the other direction.
    const { result } = renderHook(() => useUpload());
    await act(async () => {
      await expect(
        result.current.send(file("clip.mp4", 2048), () =>
          Promise.reject(new Error("nope")),
        ),
      ).rejects.toThrow("nope");
    });
    expect(result.current.inFlight).toBeNull();
  });
});
