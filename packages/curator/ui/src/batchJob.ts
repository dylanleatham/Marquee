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

/**
 * Ceiling on the backed-off retry interval. Giving up entirely would be wrong — the sweep is still
 * running on the server and Curator may come back — but retrying at the happy-path cadence forever
 * is a client hammering a service that has already told us it can't answer.
 */
export const MAX_POLL_MS = 15_000;

interface State {
  job: GenerationJob | null;
  /** Set when the *start* request itself failed — a job that never existed can't report its own error. */
  error: string | null;
  /**
   * True once polling has failed repeatedly. curator-ui-ux §10: an unreachable service is reported,
   * never fatal — without this the panel silently freezes at whatever progress it last saw, which is
   * indistinguishable from a sweep that stopped making progress.
   */
  unreachable: boolean;
}

let state: State = { job: null, error: null, unreachable: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Consecutive poll failures, for the backoff. Reset by any successful answer. */
let failures = 0;

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

/** Exponential backoff on consecutive failures: 1s, 2s, 4s, 8s, then capped at MAX_POLL_MS. */
export const pollDelay = (consecutiveFailures: number): number =>
  Math.min(POLL_MS * 2 ** consecutiveFailures, MAX_POLL_MS);

/** Enough failures to stop calling it transient and tell the user contact is lost (~7s in). */
const UNREACHABLE_AFTER = 3;

function poll(id: string): void {
  stopPolling();
  timer = setTimeout(async () => {
    try {
      const job = await api.job(id);
      // A newer sweep (or a dismiss) took over while this request was in flight — drop the answer
      // rather than resurrecting a job the user has moved past.
      if (state.job?.id !== id) return;
      failures = 0;
      set({ job, unreachable: false });
      if (isRunning(job)) poll(id);
    } catch {
      // A transient failure must not silently end the poll loop; keep trying while the job is ours.
      // But back off — a Curator that is down stays down, and a 1s retry forever is a client
      // hammering a service that has already said it can't answer.
      if (state.job?.id !== id) return;
      failures++;
      if (failures >= UNREACHABLE_AFTER && !state.unreachable)
        set({ unreachable: true });
      poll(id);
    }
  }, pollDelay(failures));
}

function adopt(job: GenerationJob): void {
  failures = 0;
  set({ job, error: null, unreachable: false });
  if (isRunning(job)) poll(job.id);
}

/** Start a palette sweep, or reattach to the one already running (the server dedups — ADR 0029). */
export async function startPaletteRegen(force = false): Promise<void> {
  try {
    adopt(await api.regeneratePalettes(force));
  } catch (err) {
    set({
      job: null,
      error: err instanceof Error ? err.message : String(err),
      unreachable: false,
    });
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
  failures = 0;
  set({ job: null, error: null, unreachable: false });
}

/** Test seam: drop all state and stop the timer between cases. */
export function resetBatchJob(): void {
  stopPolling();
  failures = 0;
  state = { job: null, error: null, unreachable: false };
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
