import { describe, it, expect } from "vitest";
import {
  GenerationJobs,
  type GenerationJob,
  type JobStore,
} from "../src/jobs/manager.js";

/** An in-memory JobStore so persistence is testable without touching the filesystem. */
function memStore(): JobStore & { data: GenerationJob[] } {
  const s = {
    data: [] as GenerationJob[],
    load: () => s.data,
    save: (jobs: GenerationJob[]) => {
      s.data = jobs;
    },
  };
  return s;
}

/** A runner that never settles on its own — only a cancel (abort) ends it. */
const neverSettles =
  () =>
  ({ signal }: { signal: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });

/** A runner whose completion the test controls, so job transitions are deterministic. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GenerationJobs", () => {
  it("starts a running job and completes with the result", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<{ videoClips: [] }>();
    const job = jobs.start("video", "abcd1234", async () => d.promise);
    expect(job.status).toBe("running");
    expect(job.kind).toBe("video");

    d.resolve({ videoClips: [] });
    await tick();
    const done = jobs.get(job.id)!;
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ videoClips: [] });
  });

  it("reports progress as items settle", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<{ videoClips: [] }>();
    const job = jobs.start("video", "abcd1234", async ({ onProgress }) => {
      onProgress(0, 3);
      onProgress(2, 3);
      return d.promise;
    });
    await tick();
    expect(jobs.get(job.id)!.progress).toEqual({ done: 2, total: 3 });
    d.resolve({ videoClips: [] });
    await tick();
    expect(jobs.get(job.id)!.status).toBe("done");
  });

  it("captures a runner failure as a failed job with the error message", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<never>();
    const job = jobs.start("cardArt", "abcd1234", async () => d.promise);
    d.reject(new Error("upstream boom"));
    await tick();
    const failed = jobs.get(job.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("upstream boom");
    expect(failed.result).toBeUndefined();
  });

  it("dedupes a running job per album+kind (clicking generate twice is a no-op)", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<{ videoClips: [] }>();
    let runs = 0;
    const runner = async () => {
      runs++;
      return d.promise;
    };
    const first = jobs.start("video", "abcd1234", runner);
    const second = jobs.start("video", "abcd1234", runner);
    expect(second.id).toBe(first.id);
    expect(runs).toBe(1);

    // A different kind for the same album is a distinct job.
    const cardJob = jobs.start("cardArt", "abcd1234", runner);
    expect(cardJob.id).not.toBe(first.id);

    // Once the first finishes, a new run is allowed again.
    d.resolve({ videoClips: [] });
    await tick();
    const third = jobs.start("video", "abcd1234", async () => deferred().promise);
    expect(third.id).not.toBe(first.id);
  });

  it("lists active + recent jobs for an album, newest first, filterable by kind", async () => {
    let t = 0;
    const jobs = new GenerationJobs({ now: () => `2026-07-21T00:00:0${t++}.000Z` });
    const v = jobs.start("video", "abcd1234", async () => deferred().promise);
    const c = jobs.start("cardArt", "abcd1234", async () => deferred().promise);
    jobs.start("video", "zzzz9999", async () => deferred().promise);

    const forAlbum = jobs.forAlbum("abcd1234");
    expect(forAlbum.map((j) => j.id)).toEqual([c.id, v.id]); // newest first
    expect(jobs.forAlbum("abcd1234", "video").map((j) => j.id)).toEqual([v.id]);
  });

  it("garbage-collects terminal jobs past their TTL", async () => {
    const jobs = new GenerationJobs({ ttlMs: 0 });
    const d = deferred<{ videoClips: [] }>();
    const job = jobs.start("video", "abcd1234", async () => d.promise);
    d.resolve({ videoClips: [] });
    await tick();
    // ttl 0 → the next lookup GCs the now-terminal job.
    await new Promise((r) => setTimeout(r, 2));
    expect(jobs.get(job.id)).toBeUndefined();
  });

  it("returns snapshots so callers can't mutate stored job state", async () => {
    const jobs = new GenerationJobs();
    const job = jobs.start("video", "abcd1234", async () => deferred().promise);
    job.progress.done = 99;
    expect(jobs.get(job.id)!.progress.done).toBe(0);
  });

  // --- cancel (issue #57) ---

  it("cancels a running job and aborts the signal handed to its runner", async () => {
    const jobs = new GenerationJobs();
    let signal!: AbortSignal;
    const job = jobs.start("video", "abcd1234", async (ctx) => {
      signal = ctx.signal;
      return neverSettles()(ctx);
    });
    expect(jobs.get(job.id)!.status).toBe("running");
    expect(signal.aborted).toBe(false);

    const cancelled = jobs.cancel(job.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(signal.aborted).toBe(true);
    await tick();
    // The abort-induced rejection is classified as cancelled, not failed.
    expect(jobs.get(job.id)!.status).toBe("cancelled");
  });

  it("is idempotent: cancelling a terminal or unknown job is a no-op", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<{ videoClips: [] }>();
    const job = jobs.start("video", "abcd1234", async () => d.promise);
    d.resolve({ videoClips: [] });
    await tick();
    expect(jobs.get(job.id)!.status).toBe("done");
    expect(jobs.cancel(job.id)!.status).toBe("done"); // unchanged
    expect(jobs.cancel("no-such-id")).toBeUndefined();
  });

  it("drops the result of a runner that resolves after it was cancelled", async () => {
    const jobs = new GenerationJobs();
    const d = deferred<{ videoClips: [] }>();
    const job = jobs.start("video", "abcd1234", async () => d.promise);
    jobs.cancel(job.id);
    d.resolve({ videoClips: [] }); // the abort raced the resolve
    await tick();
    const j = jobs.get(job.id)!;
    expect(j.status).toBe("cancelled");
    expect(j.result).toBeUndefined();
  });

  // --- persistence (issue #57) ---

  it("persists jobs and restores them into a fresh manager", async () => {
    const store = memStore();
    const jobs = new GenerationJobs({ store });
    const d = deferred<{ cardArtCandidates: [] }>();
    const job = jobs.start("cardArt", "abcd1234", async () => d.promise);
    d.resolve({ cardArtCandidates: [] });
    await tick();

    const restored = new GenerationJobs({ store });
    const j = restored.get(job.id)!;
    expect(j.status).toBe("done");
    expect(j.result).toEqual({ cardArtCandidates: [] });
  });

  it("restores a job left running at shutdown as a failed 'interrupted' job", async () => {
    const store = memStore();
    const jobs = new GenerationJobs({ store });
    const job = jobs.start("video", "abcd1234", neverSettles());
    expect(jobs.get(job.id)!.status).toBe("running"); // persisted as running

    // Simulate a restart: a new manager loads the same store. The runner is gone, so the job can't
    // be running any more — it's normalized to failed.
    const restored = new GenerationJobs({ store });
    const j = restored.get(job.id)!;
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/interrupted/i);
  });

  it("survives a corrupt/unreadable job log by starting empty", () => {
    const throwing: JobStore = {
      load: () => {
        throw new Error("corrupt json");
      },
      save: () => {},
    };
    expect(() => new GenerationJobs({ store: throwing })).not.toThrow();
  });
});
