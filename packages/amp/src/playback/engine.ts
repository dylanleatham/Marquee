// Amp's playback state for the single configured target: IDLE⇄PLAYING plus the 90-minute idle-timeout
// safety net for a lost `stop`. Deliberately mirrors hue-conductor's engine and backdrop's controller
// — an injected Timers port so the timeout is deterministic under test, and all Sonos I/O delegated to
// the SonosDriver seam.
import type { SonosDriver } from "../sonos/driver.js";

/** Injectable timer port — production uses setTimeout; tests capture the callback and fire it. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Minimal structured-logger port (pino/Fastify shape). Defaults to a no-op under test. */
export interface Logger {
  warn(payload: Record<string, unknown>, msg: string): void;
}

const noopLogger: Logger = { warn: () => {} };

export interface EngineOptions {
  timers?: Timers;
  /** Auto-stop after this long in PLAYING with no new scan (default 90 min). */
  idleTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
}

export interface NowPlaying {
  curatorId: string;
  spotifyUri: string;
  target: string;
  startedAt: string;
  /** The 1-based position within `spotifyUri` that was started, when one was asked for (ADR 0078). */
  trackNumber?: number;
}

const DEFAULT_IDLE_MS = 90 * 60 * 1000;

export class PlaybackEngine {
  private state: "idle" | "playing" = "idle";
  private playing: NowPlaying | null = null;
  private idleTimer: unknown | null = null;

  private readonly timers: Timers;
  private readonly idleTimeoutMs: number;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly driver: SonosDriver,
    opts: EngineOptions = {},
  ) {
    this.timers = opts.timers ?? realTimers;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
  }

  status(): { state: "idle" | "playing"; playing: NowPlaying | null } {
    return { state: this.state, playing: this.playing };
  }

  /**
   * Play (or swap to) an album on the target. Delegates to the driver, then records state and arms the
   * idle timeout. A driver failure propagates to the caller (which decides degrade-vs-error) — state
   * is only updated once the driver has accepted the play.
   */
  async start(
    target: string,
    spotifyUri: string,
    curatorId: string,
    trackNumber?: number,
  ): Promise<void> {
    await this.driver.play(target, spotifyUri, trackNumber);
    this.state = "playing";
    this.playing = {
      curatorId,
      spotifyUri,
      target,
      startedAt: new Date(this.now()).toISOString(),
      ...(trackNumber === undefined ? {} : { trackNumber }),
    };
    this.armIdleTimeout(target);
  }

  /** Stop playback on the target and return to idle. Idempotent. */
  async stop(target: string): Promise<void> {
    this.clearIdleTimeout();
    await this.driver.stop(target);
    this.state = "idle";
    this.playing = null;
  }

  /** Cancel any pending idle timer (shutdown / test teardown). */
  dispose(): void {
    this.clearIdleTimeout();
  }

  private armIdleTimeout(target: string): void {
    this.clearIdleTimeout();
    this.idleTimer = this.timers.set(() => {
      // Safety net only; a normal stop clears this first. Fire-and-forget — nothing awaits the timer.
      this.stop(target).catch((err) => {
        this.log.warn({ err: String(err) }, "amp idle-timeout stop failed");
      });
    }, this.idleTimeoutMs);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimer !== null) {
      this.timers.clear(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
