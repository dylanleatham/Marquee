import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GenerationJob, type JobKind } from "./api";

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
): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep the latest fetcher without making it a dependency of the effect (avoids resubscribing
  // every render when callers pass an inline arrow function).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
  }, [run, intervalMs]);

  return { data, error, loading, refresh: run };
}

export interface GenerationJobHook {
  status: "idle" | "running" | "done" | "failed";
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Kick off a new generation job (POST → poll until terminal). */
  start: () => void;
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
): GenerationJobHook {
  const [status, setStatus] = useState<GenerationJobHook["status"]>("idle");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
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
    const tick = async () => {
      try {
        const job = await api.job(id);
        setProgress(job.progress);
        if (job.status === "running") {
          timer.current = setTimeout(tick, 1500);
        } else if (job.status === "done") {
          setStatus("done");
          onDoneRef.current();
        } else {
          setStatus("failed");
          setError(job.error ?? "generation failed");
        }
      } catch (err) {
        // 404 (expired) or a network blip — stop polling and surface it.
        setStatus("failed");
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
  }, []);

  const adopt = useCallback(
    (job: GenerationJob) => {
      setProgress(job.progress);
      if (job.status === "running") {
        setStatus("running");
        setError(null);
        poll(job.id);
      } else if (job.status === "failed") {
        setStatus("failed");
        setError(job.error ?? "generation failed");
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
    starterRef.current()
      .then(adopt)
      .catch((err) => {
        setStatus("failed");
        setError(err instanceof Error ? err.message : String(err));
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
        const running = jobs.find((j) => j.status === "running");
        if (running) adopt(running);
      })
      .catch(() => {
        /* no jobs endpoint / none running — nothing to re-attach */
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [curatorId, kind, adopt, enabled]);

  return { status, progress, error, start };
}
