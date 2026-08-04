// Automatic Discogs collection polling (issue #234): every N minutes, run the same sweep the "Sync
// collection" button runs, so a record added on Discogs turns up in Marquee without anyone pressing
// anything.
//
// Discogs has no webhook or change feed, so polling is the only mechanism available. The poll runs
// the **identical full sweep** rather than a cheaper "just look at the newest page" query. That costs
// ceil(collection / 100) API requests per tick — 5 for a 500-record collection, nothing against an
// hourly budget of 3,600 — and buys two things worth more than the saving: there is exactly one sync
// code path to keep correct, and every tick is self-healing, because a sweep that was truncated or
// half-failed earlier is simply completed by the next one.
import type { GenerationJob } from "../jobs/manager.js";
import type { SyncLogger } from "../albums/discogs-sync.js";

/**
 * The floor on the poll interval. Each tick walks the whole collection against a 60-request/minute
 * budget that Roadie's own fetches are also drawing on, and new records arrive at human speed —
 * polling faster than this spends the rate limit that the actual work needs.
 */
export const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hourly: fast enough that a record added at breakfast is playable by lunch, cheap enough to ignore. */
export const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000;

export interface DiscogsPollerStatus {
  enabled: boolean;
  intervalMs: number;
  /** When the last tick fired (ISO), or null if it hasn't yet. */
  lastRunAt: string | null;
  /** The job the last tick started — the UI can poll it like any other. */
  lastJobId: string | null;
  /** Why the last tick didn't start a sweep (Discogs unconfigured, an API failure). */
  lastError: string | null;
}

export interface DiscogsPollerOptions {
  /**
   * Start one sweep and return its job — the same call the button's route makes, so the poller has no
   * private path into the sync. Returning `undefined` means "couldn't run" (e.g. Discogs isn't
   * configured); the manager's own dedupe means a tick landing during a running sweep reattaches to
   * it rather than starting a second walk of the collection.
   */
  trigger: () => GenerationJob | undefined;
  enabled: boolean;
  /** Clamped up to `MIN_POLL_INTERVAL_MS`. */
  intervalMs?: number;
  logger?: SyncLogger;
  now?: () => string;
  /** Injected by tests so scheduling is asserted without real time. */
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

const realTimers = {
  set(fn: () => void, ms: number): unknown {
    const handle = setInterval(fn, ms);
    // Never hold the process open: this is a background convenience, not a reason not to exit.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle: unknown): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * A single repeating timer that fires the collection sweep. Owns no sync logic of its own — it
 * decides *when*, `discogsSyncRunner` decides *what*.
 */
export class DiscogsPoller {
  private readonly timers: NonNullable<DiscogsPollerOptions["timers"]>;
  private readonly now: () => string;
  private handle: unknown = null;
  private lastRunAt: string | null = null;
  private lastJobId: string | null = null;
  private lastError: string | null = null;
  enabled: boolean;
  intervalMs: number;

  constructor(private readonly opts: DiscogsPollerOptions) {
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.enabled = opts.enabled;
    this.intervalMs = DiscogsPoller.clampInterval(opts.intervalMs);
  }

  private static clampInterval(ms?: number): number {
    return Math.max(MIN_POLL_INTERVAL_MS, ms ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /**
   * Apply a new schedule immediately — what the Settings toggle calls. Without this, turning
   * auto-sync on would mean "and now restart Curator", which is not what a toggle should mean. The
   * old timer is always cleared first, so changing the interval can't leave two running.
   */
  reconfigure(next: { enabled: boolean; intervalMs?: number }): void {
    this.stop();
    this.enabled = next.enabled;
    this.intervalMs = DiscogsPoller.clampInterval(next.intervalMs);
    this.start();
  }

  /**
   * Begin polling. A disabled poller is a no-op, and starting twice keeps the first timer — so a
   * double `start()` can't leave an orphaned interval firing forever.
   *
   * Deliberately does **not** sweep on boot: Curator restarts (a deploy, a crash, closing the
   * desktop app) would each spend a full collection walk, and the first tick is at most one interval
   * away. The button is there for anyone who doesn't want to wait.
   */
  start(): void {
    if (!this.enabled || this.handle !== null) return;
    this.handle = this.timers.set(() => this.tick(), this.intervalMs);
    this.opts.logger?.info(
      `Discogs auto-sync on: every ${Math.round(this.intervalMs / 60000)} min`,
    );
  }

  /** Stop polling. Idempotent — safe to call on a poller that never started. */
  stop(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  /**
   * Fire one sweep now, exactly as a tick would. A failing trigger is recorded and swallowed: an
   * unreachable Discogs must not throw out of a timer callback (unhandled, it takes the process
   * down) or stop the schedule — the next tick tries again.
   */
  tick(): GenerationJob | undefined {
    this.lastRunAt = this.now();
    try {
      const job = this.opts.trigger();
      this.lastJobId = job?.id ?? null;
      this.lastError = job ? null : "Discogs is not configured";
      if (!job)
        this.opts.logger?.warn("Discogs auto-sync skipped: not configured");
      return job;
    } catch (err) {
      this.lastJobId = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(
        `Discogs auto-sync tick failed: ${this.lastError}`,
      );
      return undefined;
    }
  }

  status(): DiscogsPollerStatus {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastJobId: this.lastJobId,
      lastError: this.lastError,
    };
  }
}
