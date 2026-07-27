// The playback state machine (backdrop-spec §7). Owns the single global IDLE⇄PLAYING state, turns
// scan events into browser commands, and runs the idle-timeout safety net. Deliberately mirrors
// hue-conductor's engine: injectable Timers so the timeout is deterministic under test, and no I/O
// of its own beyond resolving the library + checking a file exists.
import { existsSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { parseCuratorUri, type ScanEvent } from "@marquee/contracts";
import type { Broadcaster } from "./hub.js";
import type { Command, PlaybackState } from "./types.js";

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

export interface ControllerOptions {
  timers?: Timers;
  /** Auto-fade to idle after this long in PLAYING with no new scan (default 90 min). */
  idleTimeoutMs?: number;
  /** Root the resolved video file must sit under (defense-in-depth against a poisoned library). */
  mediaDir: string;
  /** Where unresolvable/missing-file scans get logged server-side (backdrop-spec §8/§9). */
  logger?: Logger;
  now?: () => number;
}

/** What the controller needs from the library — just URI resolution. */
export interface LibraryLookup {
  resolve(uri: string): { filePath: string } | undefined;
}

export interface Status {
  state: PlaybackState;
  uri: string | null;
  filePath: string | null;
  since: string;
}

const DEFAULT_IDLE_MS = 90 * 60 * 1000;

export class PlaybackController {
  private state: PlaybackState = "idle";
  private uri: string | null = null;
  private filePath: string | null = null;
  private since: number;
  private idleTimer: unknown | null = null;

  private readonly timers: Timers;
  private readonly idleTimeoutMs: number;
  private readonly mediaDir: string;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly library: LibraryLookup,
    private readonly hub: Broadcaster,
    opts: ControllerOptions,
  ) {
    this.timers = opts.timers ?? realTimers;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    this.mediaDir = opts.mediaDir;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.since = this.now();
  }

  status(): Status {
    return {
      state: this.state,
      uri: this.uri,
      filePath: this.filePath,
      since: new Date(this.since).toISOString(),
    };
  }

  /** Apply a scan event from Stylus (or an admin/simulate call). Never throws. */
  handleScan(event: ScanEvent): void {
    if (event.event === "stop") {
      this.stop();
    } else {
      this.play(event.uri);
    }
  }

  /**
   * Start (or crossfade to) an album's visualizer. Unknown URI or missing file: stay in the current
   * state and flash a corner hint — a scan for something we can't play must not blackscreen
   * (backdrop-spec §9, §13 "not-in-library happens more than you think").
   */
  play(uri: string): void {
    // A card and a sleeve for the same album share one visualizer, and Curator keys the library by
    // the album URI. So resolve any scan by its canonical album key — a `curator:card:<id>` plays
    // the same video as `curator:album:<id>` (ADR 0034). Non-curator URIs pass through unchanged and
    // miss the library as before.
    const parsed = parseCuratorUri(uri);
    const lookupUri = parsed ? `curator:album:${parsed.curatorId}` : uri;
    const entry = this.library.resolve(lookupUri);
    if (!entry) {
      this.log.warn(
        { uri },
        "scan for an album not in the library — staying put",
      );
      this.hub.broadcast({
        type: "show-message",
        text: "video not in library",
        durationMs: 4000,
      });
      return;
    }
    if (!this.fileIsPlayable(entry.filePath)) {
      this.log.warn(
        { uri, filePath: entry.filePath },
        "video file missing or outside media dir — staying put",
      );
      this.hub.broadcast({
        type: "show-message",
        text: "video file missing",
        durationMs: 4000,
      });
      return;
    }

    // Commit to the new URI before the browser finishes fading, so a rapid third scan wins cleanly
    // (spec §7 "backend commits to the new URI before the fade completes").
    this.state = "playing";
    this.uri = uri;
    this.filePath = entry.filePath;
    this.since = this.now();
    this.hub.broadcast({ type: "play", filePath: entry.filePath });
    this.armIdleTimeout();
  }

  /** Fade to idle. Idempotent — a `stop` while already idle is a no-op beyond re-broadcasting. */
  stop(): void {
    this.clearIdleTimeout();
    this.state = "idle";
    this.uri = null;
    this.filePath = null;
    this.since = this.now();
    this.hub.broadcast({ type: "stop" });
  }

  /** Cancel any pending idle timer (e.g. on shutdown / test teardown). */
  dispose(): void {
    this.clearIdleTimeout();
  }

  private fileIsPlayable(filePath: string): boolean {
    // Reject anything that resolves outside mediaDir before we ever hand it to the browser.
    const rel = relative(this.mediaDir, filePath);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return existsSync(filePath);
  }

  private armIdleTimeout(): void {
    this.clearIdleTimeout();
    this.idleTimer = this.timers.set(() => {
      // Only the safety net; a normal `stop` clears this first.
      this.stop();
    }, this.idleTimeoutMs);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimer !== null) {
      this.timers.clear(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
