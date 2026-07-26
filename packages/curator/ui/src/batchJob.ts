// The running library sweep, tracked app-wide (curator-spec §10 "Batch progress", issue #104).
//
// A module-level store rather than component state, for the same reason as roomArm: you start a
// regeneration from Settings and then go and look at an album while it runs. If the panel lived
// inside the screen that launched it, navigating away would lose the run — which is precisely the
// failure the background-job design exists to prevent (ADR 0018).
//
// Progress arrives by polling `GET /api/jobs/:id`, not SSE — see ADR 0029.
import { useSyncExternalStore } from "react";
import { api, type GenerationJob } from "./api";

/** Poll cadence. A sweep ticks once per album over minutes; a second is well inside human reading speed. */
export const POLL_MS = 1000;

interface State {
  job: GenerationJob | null;
  /** Set when the *start* request itself failed — a job that never existed can't report its own error. */
  error: string | null;
}

let state: State = { job: null, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => {
  for (const l of listeners) l();
};

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  emit();
}

const isRunning = (j: GenerationJob | null): boolean => j?.status === "running";

/** Stop polling. Does not clear the job — a finished sweep stays visible until dismissed. */
function stopPolling(): void {
  clearTimeout(timer);
  timer = undefined;
}

function poll(id: string): void {
  stopPolling();
  timer = setTimeout(async () => {
    try {
      const job = await api.job(id);
      // A newer sweep (or a dismiss) took over while this request was in flight — drop the answer
      // rather than resurrecting a job the user has moved past.
      if (state.job?.id !== id) return;
      set({ job });
      if (isRunning(job)) poll(id);
    } catch {
      // A transient failure must not silently end the poll loop; keep trying while the job is ours.
      if (state.job?.id === id) poll(id);
    }
  }, POLL_MS);
}

function adopt(job: GenerationJob): void {
  set({ job, error: null });
  if (isRunning(job)) poll(job.id);
}

/** Start a palette sweep, or reattach to the one already running (the server dedups — ADR 0029). */
export async function startPaletteRegen(force = false): Promise<void> {
  try {
    adopt(await api.regeneratePalettes(force));
  } catch (err) {
    set({ job: null, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Reattach to a sweep that was already running — called once when the app mounts, so a reload (or
 * opening the window after starting a sweep) picks the panel back up instead of leaving it invisible.
 * Silent on failure: this is opportunistic, and a Curator that can't answer has louder problems.
 */
export async function attachRunningBatch(): Promise<void> {
  if (state.job) return;
  try {
    const { jobs } = await api.libraryJobs("paletteBatch");
    const running = jobs.find((j) => j.status === "running");
    if (running) adopt(running);
  } catch {
    // no-op
  }
}

/** Cancel the sweep. The palettes already written stay written — only the remaining work stops. */
export async function cancelBatch(): Promise<void> {
  const id = state.job?.id;
  if (!id) return;
  try {
    set({ job: await api.cancelJob(id) });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
  stopPolling();
}

/** Close the panel. Only ever user-driven or on a finished job — never while work is in flight. */
export function dismissBatch(): void {
  stopPolling();
  set({ job: null, error: null });
}

/** Test seam: drop all state and stop the timer between cases. */
export function resetBatchJob(): void {
  stopPolling();
  state = { job: null, error: null };
  emit();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

const snapshot = (): State => state;

export function useBatchJob(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
