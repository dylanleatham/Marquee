// One tracked library-scoped job, as an app-wide store (ADR 0018 / ADR 0029).
//
// This is the shape every long sweep needs and none of them should re-implement: start or reattach,
// poll `GET /api/jobs/:id` with backoff, say so when contact is lost rather than freezing the bar,
// and survive navigation. It lives at module scope for the same reason as roomArm — you start a
// sweep from one screen and then go and look at an album while it runs, and a panel owned by the
// screen that launched it would die with that screen.
//
// Extracted from `batchJob.ts` when the Discogs collection sync (issue #234) needed the identical
// behaviour: two copies of a polling state machine is two places for the backoff to drift.
import { useSyncExternalStore } from "react";
import { api, type GenerationJob, type LibraryJobKind } from "./api";

/** Poll cadence. A sweep ticks once per item over minutes; a second is well inside human reading speed. */
export const POLL_MS = 1000;

/**
 * Ceiling on the backed-off retry interval. Giving up entirely would be wrong — the sweep is still
 * running on the server and Curator may come back — but retrying at the happy-path cadence forever
 * is a client hammering a service that has already told us it can't answer.
 */
export const MAX_POLL_MS = 15_000;

/** Exponential backoff on consecutive failures: 1s, 2s, 4s, 8s, then capped at MAX_POLL_MS. */
export const pollDelay = (consecutiveFailures: number): number =>
  Math.min(POLL_MS * 2 ** consecutiveFailures, MAX_POLL_MS);

/** Enough failures to stop calling it transient and tell the user contact is lost (~7s in). */
const UNREACHABLE_AFTER = 3;

export interface LibraryJobState {
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

export interface LibraryJobStore {
  /** Start the sweep, or reattach to the one already running (the server dedups). */
  start(): Promise<void>;
  /** Reattach to a sweep already running — called on mount so a reload doesn't lose the panel. */
  attachRunning(): Promise<void>;
  /** Stop the sweep. Work already committed stays committed; only the remainder stops. */
  cancel(): Promise<void>;
  /** Close the panel. Only ever user-driven or on a finished job — never while work is in flight. */
  dismiss(): void;
  /** Test seam: drop all state and stop the timer between cases. */
  reset(): void;
  use(): LibraryJobState;
}

const EMPTY: LibraryJobState = { job: null, error: null, unreachable: false };

/**
 * Build a store for one job kind. `start` is the API call that launches that sweep — the store owns
 * everything after it returns a job.
 */
export function createLibraryJobStore(
  kind: LibraryJobKind,
  startJob: () => Promise<GenerationJob>,
): LibraryJobStore {
  let state: LibraryJobState = EMPTY;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive poll failures, for the backoff. Reset by any successful answer. */
  let failures = 0;
  /** Whether the visibility listener is attached — the store outlives every panel, so bind once. */
  let bound = false;

  const emit = () => {
    for (const l of listeners) l();
  };

  const set = (next: Partial<LibraryJobState>): void => {
    state = { ...state, ...next };
    emit();
  };

  const isRunning = (j: GenerationJob | null): boolean =>
    j?.status === "running";

  /** Stop polling. Does not clear the job — a finished sweep stays visible until dismissed. */
  const stopPolling = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  /**
   * Pause the loop while the tab is hidden, and resume with an immediate fetch on return — the same
   * gate `usePoll` and `useVisibleCycle` already apply (issues #135/#136, and the idle-cost baseline
   * ADR 0049). It matters more here than it did for the palette sweep: a collection sync can run for
   * hours, and a backgrounded window would otherwise poll Curator once a second for all of them.
   */
  const onVisibility = (): void => {
    const id = state.job?.id;
    if (!id || !isRunning(state.job)) {
      endPolling();
      return;
    }
    if (document.hidden) stopPolling();
    else poll(id, true);
  };

  /** Bind the visibility gate exactly once per store, and only in a DOM (tests import this in node). */
  const watchVisibility = (): void => {
    if (bound || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", onVisibility);
    bound = true;
  };

  const unwatchVisibility = (): void => {
    if (!bound) return;
    document.removeEventListener("visibilitychange", onVisibility);
    bound = false;
  };

  /**
   * Nothing left to follow: drop the timer *and* the listener. Distinct from `stopPolling`, which
   * every reschedule calls — a store with no running job has no reason to keep a document listener
   * alive, and keeping one is how a long-lived module ends up holding many.
   */
  const endPolling = (): void => {
    stopPolling();
    unwatchVisibility();
  };

  function poll(id: string, immediate = false): void {
    stopPolling();
    // Don't schedule into a hidden tab at all; `onVisibility` restarts the loop on return.
    if (typeof document !== "undefined" && document.hidden) return;
    timer = setTimeout(
      async () => {
        try {
          const job = await api.job(id);
          // A newer sweep (or a dismiss) took over while this request was in flight — drop the answer
          // rather than resurrecting a job the user has moved past.
          if (state.job?.id !== id) return;
          failures = 0;
          set({ job, unreachable: false });
          if (isRunning(job)) poll(id);
          else endPolling();
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
      },
      immediate ? 0 : pollDelay(failures),
    );
  }

  function adopt(job: GenerationJob): void {
    failures = 0;
    set({ job, error: null, unreachable: false });
    if (isRunning(job)) {
      watchVisibility();
      poll(job.id);
    }
  }

  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  const snapshot = (): LibraryJobState => state;

  return {
    async start(): Promise<void> {
      try {
        adopt(await startJob());
      } catch (err) {
        set({
          job: null,
          error: err instanceof Error ? err.message : String(err),
          unreachable: false,
        });
      }
    },

    /**
     * Silent on failure: this is opportunistic, and a Curator that can't answer has louder problems.
     */
    async attachRunning(): Promise<void> {
      if (state.job) return;
      try {
        const { jobs } = await api.libraryJobs(kind);
        const running = jobs.find((j) => j.status === "running");
        if (running) adopt(running);
      } catch {
        // no-op
      }
    },

    async cancel(): Promise<void> {
      const id = state.job?.id;
      if (!id) return;
      try {
        set({ job: await api.cancelJob(id) });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
      endPolling();
    },

    dismiss(): void {
      endPolling();
      failures = 0;
      set(EMPTY);
    },

    reset(): void {
      endPolling();
      failures = 0;
      state = EMPTY;
      emit();
    },

    use(): LibraryJobState {
      return useSyncExternalStore(subscribe, snapshot, snapshot);
    },
  };
}
