// Roadie — the background worker inside Curator (roadie-spec §4/§5). A single-threaded queue that
// drives each newly-added album forward through its processing sub-steps until it parks at a human
// handoff (`awaiting_review`), a permanent stop (`needs_manual`), or a system fault (`errored`).
// One album at a time keeps the per-album locking story trivial (§15): the album being processed is
// the only one Roadie touches.
import type { AssetStore } from "../store/asset-store.js";
import type { SpotifyClient } from "../spotify/client.js";
import type { DiscogsClient } from "../discogs/client.js";
import type { PaletteGenerator } from "../albums/add-manual.js";
import {
  type AlbumAsset,
  type RoadieState,
  HISTORY_CAP,
  isProcessingState,
  deriveStatus,
} from "../albums/asset.js";
import { STEPS, defaultGenerate, type Step, type StepDeps } from "./steps.js";
import type { GeminiClient } from "../gemini/client.js";
import { TransientError, PermanentError, ConfigError } from "./errors.js";
import { backoffDelay, maxRetries, realSleep } from "./backoff.js";

export interface RoadieLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: RoadieLogger = { info() {}, warn() {}, error() {} };

export interface RoadieOptions {
  store: AssetStore;
  spotify?: SpotifyClient;
  discogs?: DiscogsClient;
  /** Gemini client for LLM-authored prompts; absent → the drafter uses the deterministic templates. */
  gemini?: GeminiClient;
  /** Palette generator; defaults to real Palette Press. Tests inject a fake. */
  generate?: PaletteGenerator;
  /** Injectable clock + sleep so tests run with fake time (roadie-spec §13). */
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  logger?: RoadieLogger;
}

export interface ActivityEntry {
  curatorId: string;
  from: RoadieState;
  to: RoadieState;
  at: string;
}

/** How many recent transitions to keep for the observability endpoint (roadie-spec §12). */
const ACTIVITY_CAP = 20;

export class Roadie {
  private readonly store: AssetStore;
  private readonly deps: StepDeps;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private readonly log: RoadieLogger;

  private readonly queued: string[] = [];
  private current: string | null = null;
  private paused = false;
  private running: Promise<void> | null = null;
  private readonly activity: ActivityEntry[] = [];

  constructor(opts: RoadieOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sleep = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    this.log = opts.logger ?? noopLogger;
    this.deps = {
      store: opts.store,
      spotify: opts.spotify,
      discogs: opts.discogs,
      gemini: opts.gemini,
      generate: opts.generate ?? defaultGenerate,
      now: this.now,
      logger: this.log,
    };
  }

  /** Queue an album for processing and kick the worker loop if it's idle. */
  enqueue(curatorId: string): void {
    if (this.queued.includes(curatorId) || this.current === curatorId) return;
    this.queued.push(curatorId);
    this.kick();
  }

  /**
   * Re-enqueue every album found mid-processing on disk (roadie-spec §5: resume from the last
   * completed sub-step after a crash/restart). Call once at startup, before serving requests.
   */
  recover(): void {
    for (const asset of this.store.list()) {
      if (isProcessingState(asset.roadie.state)) this.enqueue(asset.curatorId);
    }
  }

  pause(): void {
    this.paused = true;
    this.log.info("Roadie paused");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.log.info("Roadie resumed");
    this.kick();
  }

  /**
   * Manually re-trigger an album parked in `errored` or `needs_manual` (roadie-spec §8). Resets the
   * retry counter and clears the last error, then resumes from wherever the album currently sits.
   */
  retry(curatorId: string): {
    ok: boolean;
    state?: RoadieState;
    error?: string;
  } {
    const asset = this.store.read(curatorId);
    if (!asset) return { ok: false, error: "not found" };
    const { state } = asset.roadie;
    if (state !== "errored" && state !== "needs_manual")
      return { ok: false, error: `album is ${state}, not retryable`, state };

    // Resume from the sub-step the album was working when it failed; fall back to the source's start.
    const resumeFrom: RoadieState =
      asset.roadie.subState &&
      isProcessingState(asset.roadie.subState as RoadieState)
        ? (asset.roadie.subState as RoadieState)
        : asset.metadata.source === "manual"
          ? "generating_palette"
          : "fetching_metadata";

    asset.roadie.state = resumeFrom;
    asset.roadie.subState = resumeFrom;
    asset.roadie.retryCount = 0;
    asset.roadie.lastError = null;
    asset.roadie.flags.album_not_on_spotify = false;
    this.persist(asset);
    this.enqueue(curatorId);
    return { ok: true, state: resumeFrom };
  }

  /** Current activity snapshot for the status endpoint (roadie-spec §12). */
  status(): {
    current: string | null;
    queueDepth: number;
    paused: boolean;
    activity: ActivityEntry[];
  } {
    return {
      current: this.current,
      queueDepth: this.queued.length,
      paused: this.paused,
      activity: [...this.activity],
    };
  }

  /** Resolve once the queue is drained and the worker is idle (tests await this). */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running || this.paused) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  private async run(): Promise<void> {
    while (!this.paused) {
      const next = this.queued.shift();
      if (next === undefined) return;
      this.current = next;
      try {
        await this.processOne(next);
      } catch (err) {
        // processOne handles its own failures; anything escaping here is a worker bug.
        this.log.error(
          `Roadie worker error on ${next}: ${(err as Error).message}`,
        );
      } finally {
        this.current = null;
      }
    }
  }

  /** Drive one album through as many sub-steps as it can advance in a single visit. */
  private async processOne(curatorId: string): Promise<void> {
    let asset = this.store.read(curatorId);
    if (!asset) {
      this.log.warn(`Roadie asked to process ${curatorId} but it's gone`);
      return;
    }

    while (isProcessingState(asset.roadie.state)) {
      const from = asset.roadie.state;
      const step = STEPS[from];
      if (!step) {
        this.fail(
          asset,
          new ConfigError(`No step registered for state ${from}`),
        );
        return;
      }

      let to: RoadieState;
      try {
        to = await this.runWithRetry(asset, step);
      } catch (err) {
        this.fail(asset, err);
        return;
      }

      this.advance(asset, from, to);
      // Re-read so a concurrent human edit wins (§15); if the album was deleted, stop — don't
      // resurrect it by continuing to persist the in-memory copy.
      const fresh = this.store.read(curatorId);
      if (!fresh) {
        this.log.warn(
          `Roadie stopped: ${curatorId} was removed mid-processing`,
        );
        return;
      }
      asset = fresh;
    }
  }

  /**
   * Run a step, retrying transient failures with exponential backoff (roadie-spec §8). Permanent and
   * config failures rethrow immediately for the caller to park. After the schedule is exhausted a
   * transient failure is promoted to a config/errored fault so the album stops rather than loops.
   */
  private async runWithRetry(
    asset: AlbumAsset,
    step: Step,
  ): Promise<RoadieState> {
    for (let attempt = 0; ; attempt++) {
      try {
        const to = await step(asset, this.deps);
        return to;
      } catch (err) {
        if (err instanceof PermanentError || err instanceof ConfigError)
          throw err;
        if (!(err instanceof TransientError)) throw err; // unexpected → errored
        const nextAttempt = attempt + 1;
        if (nextAttempt > maxRetries)
          throw new ConfigError(
            `gave up after ${maxRetries} retries: ${err.message}`,
            err,
          );
        asset.roadie.retryCount = nextAttempt;
        asset.roadie.lastError = { message: err.message };
        this.persist(asset);
        this.log.warn(
          `Roadie retry ${nextAttempt}/${maxRetries} on ${asset.curatorId} (${asset.roadie.state}): ${err.message}`,
        );
        await this.sleep(backoffDelay(nextAttempt, this.rand));
      }
    }
  }

  /** Record a successful transition: update state/subState/history, clear error, persist, log. */
  private advance(asset: AlbumAsset, from: RoadieState, to: RoadieState): void {
    const at = this.now();
    asset.roadie.state = to;
    asset.roadie.subState = isProcessingState(to) ? to : null;
    asset.roadie.retryCount = 0;
    asset.roadie.lastError = null;
    this.pushHistory(asset, to, at);
    this.persist(asset);
    this.record({ curatorId: asset.curatorId, from, to, at });
    this.log.info(`Roadie ${asset.curatorId}: ${from} → ${to}`);
  }

  /** Park an album on failure: needs_manual (permanent) or errored (config/unexpected). */
  private fail(asset: AlbumAsset, err: unknown): void {
    const at = this.now();
    const from = asset.roadie.state;
    if (err instanceof PermanentError) {
      asset.roadie.state = "needs_manual";
      asset.roadie.lastError = { message: err.message, reason: err.reason };
      if (err.reason === "album_not_on_spotify")
        asset.roadie.flags.album_not_on_spotify = true;
      this.log.warn(
        `Roadie ${asset.curatorId}: ${from} → needs_manual (${err.reason})`,
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      asset.roadie.state = "errored";
      asset.roadie.lastError = { message };
      this.log.error(
        `Roadie ${asset.curatorId}: ${from} → errored: ${message}`,
      );
    }
    asset.roadie.subState = null;
    this.pushHistory(asset, asset.roadie.state, at);
    this.persist(asset);
    this.record({
      curatorId: asset.curatorId,
      from,
      to: asset.roadie.state,
      at,
    });
  }

  private pushHistory(asset: AlbumAsset, state: RoadieState, at: string): void {
    asset.roadie.history.push({ state, at });
    if (asset.roadie.history.length > HISTORY_CAP)
      asset.roadie.history.splice(0, asset.roadie.history.length - HISTORY_CAP);
  }

  private persist(asset: AlbumAsset): void {
    asset.status = deriveStatus(asset.roadie);
    this.store.save(asset);
  }

  private record(entry: ActivityEntry): void {
    this.activity.unshift(entry);
    if (this.activity.length > ACTIVITY_CAP)
      this.activity.length = ACTIVITY_CAP;
  }
}
