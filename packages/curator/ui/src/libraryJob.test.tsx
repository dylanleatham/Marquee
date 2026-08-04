// The shared library-sweep store (issue #234 / ADR 0051) — the polling state machine behind both the
// palette sweep and the Discogs collection sync. It was never directly tested while it lived inside
// batchJob.ts; extracting it made it a shared surface, and the things it has to get right are all on
// the failure path: a poll that stops silently, a bar that freezes rather than admitting it lost
// contact, and a stale response resurrecting a job the user already moved past.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

vi.mock("./api", () => ({
  api: {
    job: vi.fn(),
    cancelJob: vi.fn(),
    libraryJobs: vi.fn(),
    syncDiscogs: vi.fn(),
    regeneratePalettes: vi.fn(),
  },
}));

import { api, type GenerationJob } from "./api";
import {
  createLibraryJobStore,
  pollDelay,
  POLL_MS,
  MAX_POLL_MS,
  type LibraryJobStore,
} from "./libraryJob";

const job = (patch: Partial<GenerationJob> = {}): GenerationJob => ({
  id: "j1",
  kind: "discogsSync",
  status: "running",
  progress: { done: 0, total: 10 },
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  ...patch,
});

/** Read the store's live state from a mounted hook, the way a panel does. */
const watch = (store: LibraryJobStore) => renderHook(() => store.use());

/**
 * Let `n` poll ticks (and the promises they await) land, at the backed-off worst case — so a test
 * that doesn't care about the backoff schedule doesn't have to model it. Use `step` instead when the
 * point is *which* answer arrived when: this can run several happy-path polls inside one call.
 */
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_POLL_MS);
    });
  }
};

/** Exactly one happy-path poll interval. */
const step = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
};

const polls = () => vi.mocked(api.job).mock.calls.length;

/** Background or foreground the tab, the way a real visibilitychange arrives. */
const hide = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

/**
 * Every store built in a test, so it can be reset afterwards. A store that ends a test still tracking
 * a running job keeps its `visibilitychange` listener attached to the shared jsdom `document`, and
 * would then react to the next test's events — quietly polling through a mock it doesn't own.
 */
const built: LibraryJobStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  while (built.length) built.pop()!.reset();
  hide(false);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("pollDelay", () => {
  it("backs off exponentially, then caps", () => {
    // A Curator that is down stays down; a 1s retry forever is a client hammering a service that
    // has already said it can't answer.
    expect(pollDelay(0)).toBe(POLL_MS);
    expect(pollDelay(1)).toBe(2000);
    expect(pollDelay(2)).toBe(4000);
    expect(pollDelay(10)).toBe(MAX_POLL_MS);
  });
});

describe("createLibraryJobStore", () => {
  const build = (start = vi.fn(async () => job())) => {
    const store = createLibraryJobStore("discogsSync", start);
    built.push(store);
    return { store, start };
  };

  it("starts with nothing to show", () => {
    const { store } = build();
    const { result } = watch(store);
    expect(result.current).toEqual({
      job: null,
      error: null,
      unreachable: false,
    });
  });

  it("adopts a started job and follows it to completion", async () => {
    const { store, start } = build();
    vi.mocked(api.job)
      .mockResolvedValueOnce(job({ progress: { done: 5, total: 10 } }))
      .mockResolvedValueOnce(job({ status: "done" }));
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.current.job?.id).toBe("j1");

    await step();
    expect(result.current.job?.progress).toEqual({ done: 5, total: 10 });

    await step();
    expect(result.current.job?.status).toBe("done");

    // Polling stops at a terminal job — no runaway timer after the sweep ends.
    const settled = polls();
    await tick(3);
    expect(polls()).toBe(settled);
  });

  it("surfaces a start that failed outright", async () => {
    const { store } = build(
      vi.fn(async () => {
        throw new Error("Discogs not configured");
      }),
    );
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });

    // A job that never existed can't report its own error, so the store carries it.
    expect(result.current.error).toBe("Discogs not configured");
    expect(result.current.job).toBeNull();
    await tick();
    expect(api.job).not.toHaveBeenCalled();
  });

  it("keeps polling through a transient failure rather than ending the loop", async () => {
    const { store } = build();
    vi.mocked(api.job)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(job({ status: "done" }));
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    await tick(2);

    expect(polls()).toBe(2);
    expect(result.current.job?.status).toBe("done");
  });

  it("says contact is lost after repeated failures, and recovers when it comes back", async () => {
    // Without this the panel silently freezes at the last progress it saw, which reads as a stalled
    // sweep rather than a stalled connection (curator-ui-ux §10).
    const { store } = build();
    vi.mocked(api.job).mockRejectedValue(new Error("down"));
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    await tick(3);
    expect(result.current.unreachable).toBe(true);
    // Degraded, not fatal: the job is still on screen with its last known progress.
    expect(result.current.job?.id).toBe("j1");

    vi.mocked(api.job).mockResolvedValue(job({ status: "done" }));
    await tick(2);
    expect(result.current.unreachable).toBe(false);
  });

  it("cancels through the API and stops polling", async () => {
    const { store } = build();
    vi.mocked(api.job).mockResolvedValue(job());
    vi.mocked(api.cancelJob).mockResolvedValue(job({ status: "cancelled" }));
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    await act(async () => {
      await store.cancel();
    });

    expect(api.cancelJob).toHaveBeenCalledWith("j1");
    expect(result.current.job?.status).toBe("cancelled");
    const settled = polls();
    await tick(3);
    expect(polls()).toBe(settled);
  });

  it("cancel on an empty store is a no-op", async () => {
    const { store } = build();
    await store.cancel();
    expect(api.cancelJob).not.toHaveBeenCalled();
  });

  it("dismiss clears the panel and leaves no timer behind", async () => {
    const { store } = build();
    vi.mocked(api.job).mockResolvedValue(job());
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    act(() => store.dismiss());

    expect(result.current.job).toBeNull();
    const settled = polls();
    await tick(3);
    expect(polls()).toBe(settled);
  });

  it("reattaches to a sweep already running, asking for its own kind", async () => {
    const { store } = build();
    vi.mocked(api.libraryJobs).mockResolvedValue({
      jobs: [job({ id: "old", status: "done" }), job({ id: "live" })],
    });
    const { result } = watch(store);

    await act(async () => {
      await store.attachRunning();
    });

    expect(api.libraryJobs).toHaveBeenCalledWith("discogsSync");
    // The *running* one is adopted, not the finished one sitting beside it.
    expect(result.current.job?.id).toBe("live");
  });

  it("reattach does nothing when a job is already tracked", async () => {
    const { store } = build();
    vi.mocked(api.job).mockResolvedValue(job());

    await act(async () => {
      await store.start();
    });
    await store.attachRunning();

    expect(api.libraryJobs).not.toHaveBeenCalled();
  });

  it("reattach is silent when Curator can't answer", async () => {
    const { store } = build();
    vi.mocked(api.libraryJobs).mockRejectedValue(new Error("down"));
    const { result } = watch(store);

    // Opportunistic on mount: a Curator that can't answer has louder problems than a missing panel.
    await act(async () => {
      await store.attachRunning();
    });

    expect(result.current.error).toBeNull();
  });

  it("drops a poll answer for a job the user has already moved past", async () => {
    // Without the guard, a reply still in flight when the panel was dismissed would resurrect the
    // old job on top of whatever replaced it.
    const { store } = build();
    let answer!: (j: GenerationJob) => void;
    vi.mocked(api.job).mockImplementationOnce(
      () =>
        new Promise<GenerationJob>((resolve) => {
          answer = resolve;
        }),
    );
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS); // the poll fires and hangs
    });
    act(() => store.dismiss());
    await act(async () => {
      answer(job({ status: "done" }));
    });
    await tick();

    expect(result.current.job).toBeNull();
    // And no follow-up poll was scheduled off the stale answer.
    expect(polls()).toBe(1);
  });

  it("two stores of different kinds don't share state", async () => {
    // The palette sweep and the collection sync are on screen at the same time; a shared module-level
    // variable between them would show one sweep's progress in the other's panel.
    const a = createLibraryJobStore("discogsSync", async () =>
      job({ id: "a" }),
    );
    const b = createLibraryJobStore("paletteBatch", async () =>
      job({ id: "b", kind: "paletteBatch" }),
    );
    vi.mocked(api.job).mockResolvedValue(job({ status: "done" }));
    const watchA = watch(a);
    const watchB = watch(b);

    await act(async () => {
      await a.start();
    });

    expect(watchA.result.current.job?.id).toBe("a");
    expect(watchB.result.current.job).toBeNull();
  });

  it("stops polling while the tab is hidden, and resumes on return", async () => {
    // A collection sync can run for hours; a backgrounded window polling Curator once a second for
    // all of them is the idle-cost pattern issues #135/#136 already closed for usePoll.
    const { store } = build();
    vi.mocked(api.job).mockResolvedValue(job());
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    await step();
    const whileVisible = polls();
    expect(whileVisible).toBeGreaterThan(0);

    hide(true);
    await tick(3);
    expect(polls()).toBe(whileVisible); // nothing while hidden

    hide(false);
    await tick();
    expect(polls()).toBeGreaterThan(whileVisible); // and it picks straight back up
    expect(result.current.job?.status).toBe("running");
  });

  it("doesn't resume a finished sweep when the tab comes back", async () => {
    // Counted by this store's own job id, not the shared call count: the point is that *this* store
    // stops asking, and a sibling store still polling would otherwise mask or fake the result.
    const id = "terminal-job";
    const { store } = build(vi.fn(async () => job({ id })));
    vi.mocked(api.job).mockResolvedValue(job({ id, status: "done" }));
    watch(store);
    const mine = () =>
      vi.mocked(api.job).mock.calls.filter(([arg]) => arg === id).length;

    await act(async () => {
      await store.start();
    });
    await step();
    const settled = mine();
    expect(settled).toBe(1);

    hide(true);
    hide(false);
    await tick(3);

    expect(mine()).toBe(settled);
  });

  it("reset drops state and stops the timer", async () => {
    const { store } = build();
    vi.mocked(api.job).mockResolvedValue(job());
    const { result } = watch(store);

    await act(async () => {
      await store.start();
    });
    act(() => store.reset());

    expect(result.current.job).toBeNull();
    const settled = polls();
    await tick(3);
    expect(polls()).toBe(settled);
  });
});
