import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type GenerationJob,
  type JobKind,
  type UploadOptions,
  type VideoPresence,
} from "./api";
import { errorMessage } from "./errors";

export interface Poll<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Force an immediate refetch (e.g. right after a mutation). */
  refresh: () => void;
}

/**
 * Poll an async fetcher on an interval and expose the latest value. The queue view leans on this so
 * albums visibly "flow" through states as Roadie processes them, without a websocket. Polling pauses
 * while the tab is hidden to avoid pointless load, and resumes (with an immediate fetch) on return.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs = 2000,
  /**
   * What the fetcher is *about*. Change it and the poll refetches immediately instead of waiting out
   * the interval.
   *
   * React Router reuses a component when only a route param changes, so `/room/a` → `/room/b` never
   * remounts and the fetcher ref updates silently — leaving the previous record on screen for a
   * whole interval while the room already plays the new one. Pass `curatorId` here and the screen
   * catches up at once.
   */
  resetKey?: string | number,
): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep the latest fetcher without making it a dependency of the effect (avoids resubscribing
  // every render when callers pass an inline arrow function).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  /**
   * Coalesce overlapping polls onto one in-flight request.
   *
   * The interval does not wait for the previous fetch. That is harmless for a small endpoint, but
   * the System screen fans out to four services with each probe bounded at 5s — so when the runtime
   * is *down*, which is exactly when that page is open, a request takes about as long as the
   * interval and the next lands on top of it, piling up fan-outs against a host that is already not
   * answering. A tick arriving mid-flight is dropped instead.
   *
   * An explicit `refresh()` is **not** dropped: it usually follows a mutation, so joining the
   * in-flight request would show pre-mutation data. It queues one follow-up fetch instead — one,
   * however many times it is called, since they would all read the same state.
   */
  const inFlight = useRef(false);
  const queued = useRef(false);

  const run = useCallback(async (force = false) => {
    if (inFlight.current) {
      queued.current ||= force;
      return;
    }
    inFlight.current = true;
    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void run(true);
      }
    }
  }, []);

  const refresh = useCallback(() => void run(true), [run]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      run();
      timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (!document.hidden) start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `resetKey` restarts the whole cycle, which fetches immediately — the point of passing it.
  }, [run, intervalMs, resetKey]);

  return { data, error, loading, refresh };
}

export interface VisibleCycle {
  /** The current step, always within `[0, length)`. */
  index: number;
  /** Attach to the animating element to also pause it while it is scrolled off screen. Optional. */
  ref: (node: Element | null) => void;
}

/**
 * Step through `length` items every `holdMs`, but only while someone can actually see them (issue
 * #136). The palette previews each grew their own bare `setInterval`, which re-rendered on a hidden
 * tab forever; this is the one gated implementation they share, so a third preview inherits the
 * gating instead of re-introducing the bug.
 *
 * Two gates, cheapest first: the tab's `visibilitychange` (same mechanism `usePoll` uses), and —
 * when the caller attaches `ref` — an `IntersectionObserver` for the off-screen case. Environments
 * without `IntersectionObserver` simply keep the visibility gate.
 */
export function useVisibleCycle(length: number, holdMs: number): VisibleCycle {
  const [index, setIndex] = useState(0);
  const [onScreen, setOnScreen] = useState(true);
  // Node in state, not a ref: attaching has to re-run the observer effect, and a ref mutation won't.
  const [node, setNode] = useState<Element | null>(null);
  const ref = useCallback((next: Element | null) => setNode(next), []);

  useEffect(() => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) =>
      setOnScreen(Boolean(entry?.isIntersecting)),
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node]);

  useEffect(() => {
    // Nothing to cycle through (0 or 1 items) means no timer at all, not a timer that no-ops.
    if (length < 2 || !onScreen) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer = setInterval(() => setIndex((i) => (i + 1) % length), holdMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (!document.hidden) start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [length, holdMs, onScreen]);

  // Modulo on the way out rather than resetting on length change: a palette that shrinks under the
  // cursor keeps animating from a valid step instead of jumping back to the first colour.
  return { index: length > 0 ? index % length : 0, ref };
}

/**
 * Track whether a single async action is in flight, for per-button loading affordances (issue #62).
 * `wrap` runs the given thunk, flipping `pending` true for its duration — so each button owns its own
 * spinner/disabled state instead of sharing one page-level boolean. The thunk is invoked
 * synchronously (before the first await), so callers relying on the underlying call firing on click
 * are unaffected.
 */
export function usePending(): [boolean, (fn: () => unknown) => Promise<void>] {
  const [pending, setPending] = useState(false);
  const wrap = useCallback(async (fn: () => unknown): Promise<void> => {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }, []);
  return [pending, wrap];
}

/** A file on its way to Curator, in the numbers `UploadStrip` prints. */
export interface UploadInFlight {
  /** The file's own name — what the user picked, so the strip names the thing they are waiting on. */
  name: string;
  sent: number;
  /** The body's size. Never 0 in practice: an unknown-length progress event keeps the file's size. */
  total: number;
  /** For the ETA, which comes from how fast this transfer has actually been going. */
  startedAt: number;
}

/**
 * One in-flight upload, for the panels that take a file (issue #284).
 *
 * Both of them used to render nothing between the file chooser closing and the server answering —
 * for a several-hundred-megabyte visualizer that is the whole transfer, and silence there reads as a
 * press that missed. One hook rather than two `useState`s so the visualizer and card panels can't
 * drift into two idioms for the same wait, the way the Backdrop leg once did.
 *
 * Errors are not swallowed: `send` rejects exactly as its poster does, so the page's `run` still owns
 * what a failure looks like. All this owns is the strip's state, and it clears it either way.
 */
export function useUpload(): {
  inFlight: UploadInFlight | null;
  /** Run `post` with progress wired in; resolves and rejects as `post` itself does. */
  send: <T>(
    file: File,
    post: (opts: UploadOptions) => Promise<T>,
  ) => Promise<T>;
} {
  const [inFlight, setInFlight] = useState<UploadInFlight | null>(null);

  const send = useCallback(
    async <T>(
      file: File,
      post: (opts: UploadOptions) => Promise<T>,
    ): Promise<T> => {
      setInFlight({
        name: file.name,
        sent: 0,
        total: file.size,
        startedAt: Date.now(),
      });
      try {
        return await post({
          onProgress: (sent, total) =>
            // A total of 0 means "the browser won't say", not "the file is empty" — keep the size we
            // already know from the file itself rather than throwing the percentage away.
            setInFlight((cur) =>
              cur ? { ...cur, sent, total: total || cur.total } : cur,
            ),
        });
      } finally {
        setInFlight(null);
      }
    },
    [],
  );

  return { inFlight, send };
}

export interface GenerationJobHook {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Kick off a new generation job (POST → poll until terminal). */
  start: () => void;
  /** Cancel the in-flight job (issue #57). No-op when nothing is running. */
  cancel: () => void;
}

/**
 * Drive one long-running generation job (issue #30 / ADR 0018): start it, poll `GET /api/jobs/:id`
 * for progress, and re-attach to an already-running job on mount so a page reload doesn't lose an
 * in-flight generation. On completion it calls `onDone` (the caller's album refresh) so the new
 * clips/candidates land immediately rather than on the next slow album poll.
 */
export function useGenerationJob(
  curatorId: string,
  kind: JobKind,
  starter: () => Promise<GenerationJob>,
  onDone: () => void,
  enabled = true,
  /** For a per-prompt job (ADR 0021/0022): only re-attach to a running job for this prompt index.
   * Omit (undefined) for a whole-set job — which matches only the set job, not any per-prompt one. */
  index?: number,
): GenerationJobHook {
  const [status, setStatus] = useState<GenerationJobHook["status"]>("idle");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** The id of the job currently being polled — lets cancel() target it. */
  const jobId = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const starterRef = useRef(starter);
  starterRef.current = starter;

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const poll = useCallback((id: string) => {
    stop();
    jobId.current = id;
    const tick = async () => {
      try {
        const job = await api.job(id);
        setProgress(job.progress);
        if (job.status === "running") {
          timer.current = setTimeout(tick, 1500);
        } else if (job.status === "done") {
          setStatus("done");
          onDoneRef.current();
        } else if (job.status === "cancelled") {
          setStatus("cancelled");
        } else {
          setStatus("failed");
          setError(job.error ?? "generation failed");
        }
      } catch (err) {
        // 404 (expired) or a network blip — stop polling and surface it.
        setStatus("failed");
        setError(errorMessage(err));
      }
    };
    void tick();
  }, []);

  const cancel = useCallback(() => {
    const id = jobId.current;
    if (!id) return;
    stop();
    setStatus("cancelled");
    // Fire-and-forget: the optimistic status flips immediately; a failed request just means the job
    // finishes on its own (the next poll would have shown it) — nothing to strand the UI on.
    void api.cancelJob(id).catch(() => {});
  }, []);

  const adopt = useCallback(
    (job: GenerationJob) => {
      setProgress(job.progress);
      jobId.current = job.id;
      if (job.status === "running") {
        setStatus("running");
        setError(null);
        poll(job.id);
      } else if (job.status === "failed") {
        setStatus("failed");
        setError(job.error ?? "generation failed");
      } else if (job.status === "cancelled") {
        setStatus("cancelled");
      } else {
        setStatus("done"); // results already on the asset; the album poll shows them
      }
    },
    [poll],
  );

  const start = useCallback(() => {
    setStatus("running");
    setError(null);
    setProgress({ done: 0, total: 0 });
    starterRef
      .current()
      .then(adopt)
      .catch((err) => {
        setStatus("failed");
        setError(errorMessage(err));
      });
  }, [adopt]);

  // Re-attach to a running job on mount (survives a page reload). Skipped when generation is off, so
  // an album view with Gemini disabled makes no extra requests.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .albumJobs(curatorId, kind)
      .then(({ jobs }) => {
        if (cancelled) return;
        // Match this hook's scope: a per-prompt hook (index set) re-attaches only to its own index;
        // a whole-set hook (index undefined) re-attaches only to the set job, never a per-prompt one.
        const running = jobs.find(
          (j) => j.status === "running" && j.index === index,
        );
        if (running) adopt(running);
      })
      .catch(() => {
        /* no jobs endpoint / none running — nothing to re-attach */
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [curatorId, kind, adopt, enabled, index]);

  return { status, progress, error, start, cancel };
}

/**
 * Watch the album's media-transfer job, reattaching by polling rather than being handed an id — so a
 * reload, or arriving while a transfer from an earlier session runs, still finds it.
 *
 * Lives here beside `useGenerationJob` so the component stays presentational. Polling continues after a terminal status (slowly): the component never remounts,
 * so stopping would mean a second video attached on the same page showed no progress at all.
 */
export function useMediaTransferJob(curatorId: string): {
  job: GenerationJob | null;
  startedAt: number | null;
} {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const startedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const { jobs } = await api.albumJobs(curatorId, "mediaTransfer");
        const latest = jobs[0] ?? null;
        if (!live) return;
        setJob(latest);
        if (latest?.status === "running") {
          startedAt.current ??= Date.now();
          timer.current = setTimeout(tick, 1000);
        } else {
          startedAt.current = null;
          timer.current = setTimeout(tick, 5000);
        }
      } catch {
        // A transfer panel must never be the thing that breaks the page; try again next tick.
        if (live) timer.current = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [curatorId]);

  return { job, startedAt: startedAt.current };
}

/** How often the record page re-asks Backdrop whether it holds the clip. */
export const PRESENCE_POLL_MS = 15000;

/**
 * Ask Backdrop whether it holds this record's clip (issue #296).
 *
 * **Asked, never inferred.** The panel used to read presence off the transfer job, so "no job is in
 * trouble" rendered as "the file is there" — which is true of every clip that was never pushed.
 *
 * Slow-polled rather than folded into the record page's asset poll: this leaves the machine, and it
 * only changes when a transfer finishes or someone clears Backdrop's library. `usePoll` already
 * pauses while the tab is hidden and drops a tick that arrives mid-flight, so an unreachable
 * Backdrop costs one bounded request per interval rather than a pile-up.
 *
 * `hasVideo: false` short-circuits without a request — there is nothing for Backdrop to hold, and
 * the strip renders nothing at all in that case.
 */
export function useBackdropPresence(
  curatorId: string,
  hasVideo: boolean,
): { presence: VideoPresence | null; refresh: () => void } {
  const { data, error, loading, refresh } = usePoll(
    async () =>
      hasVideo ? (await api.albumPresence(curatorId)).video : "unknown",
    PRESENCE_POLL_MS,
    `${curatorId}:${hasVideo}`,
  );
  // `null` until the first answer arrives, so the strip stays quiet rather than flashing "can't
  // tell" on every page open. Distinct from `unknown`, which is a real answer: we asked and Backdrop
  // did not say. A failed request is `unknown`, never "fine" — the point of the three-way answer.
  if (error) return { presence: "unknown", refresh };
  if (loading && data === null) return { presence: null, refresh };
  return { presence: data ?? "unknown", refresh };
}
