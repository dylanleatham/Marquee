import { useCallback, useEffect, useRef, useState } from "react";

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
