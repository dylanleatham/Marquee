// The playback state machine (backdrop-spec §7). Owns the single global IDLE⇄PLAYING state, turns
// scan events into browser commands, and runs the idle-timeout safety net. Deliberately mirrors
// hue-conductor's engine: injectable Timers so the timeout is deterministic under test, and no I/O
// of its own beyond resolving the library + checking a file exists.
import { existsSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import {
  entryHasOwnVideo,
  parseCuratorUri,
  type LibraryEntry,
  type ScanEvent,
} from "@marquee/contracts";
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
  /**
   * The clip played for a record Curator knows about that has no visualizer of its own, and for one
   * whose file never landed (ADR 0073). Omitted → no fallback, and both cases keep their old
   * stay-put behaviour, which is what a Backdrop with no default clip on disk does anyway.
   */
  defaultVisualizerPath?: string;
  /** Where unresolvable/missing-file scans get logged server-side (backdrop-spec §8/§9). */
  logger?: Logger;
  now?: () => number;
}

/** What the controller needs from the library — just URI resolution. */
export interface LibraryLookup {
  resolve(uri: string): LibraryEntry | undefined;
}

export interface Status {
  state: PlaybackState;
  uri: string | null;
  filePath: string | null;
  /**
   * Whether what is on screen is the default clip rather than this record's own visualizer
   * (ADR 0073). The room never goes dead, so this field is the only way to tell from off-site that a
   * record is playing a stand-in — without it the fallback would hide the very gap it papers over.
   */
  usingDefault: boolean;
  since: string;
}

const DEFAULT_IDLE_MS = 90 * 60 * 1000;

/**
 * Whether a library entry's `filePath` is something we would actually hand the browser: it must sit
 * under `mediaDir` (defense-in-depth against a poisoned library) **and** the bytes must be there.
 *
 * Exported so `GET /api/library` reports the same verdict the controller enforces at play time. When
 * these were two separate judgements, Curator could sync an entry, see it listed, and still get a
 * silent no-op on scan because the mp4 had never been moved — which is exactly how DAMN. sat in the
 * library unplayable for a day.
 */
export function fileIsPlayable(mediaDir: string, filePath: string): boolean {
  const rel = relative(mediaDir, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return existsSync(filePath);
}

export class PlaybackController {
  private state: PlaybackState = "idle";
  private uri: string | null = null;
  private filePath: string | null = null;
  private usingDefault = false;
  private since: number;
  private idleTimer: unknown | null = null;

  private readonly timers: Timers;
  private readonly idleTimeoutMs: number;
  private readonly mediaDir: string;
  private readonly defaultVisualizerPath: string | null;
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
    this.defaultVisualizerPath = opts.defaultVisualizerPath ?? null;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.since = this.now();
  }

  status(): Status {
    return {
      state: this.state,
      uri: this.uri,
      filePath: this.filePath,
      usingDefault: this.usingDefault,
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
   * Start (or crossfade to) an album's visualizer. Unknown URI: stay in the current state and flash
   * a corner hint — a scan for something we can't play must not blackscreen (backdrop-spec §9, §13
   * "not-in-library happens more than you think").
   *
   * A record Curator *does* know about, which has no visualizer of its own or whose file never
   * landed, plays the default clip instead of nothing (ADR 0073). The two are kept apart on purpose:
   * an absent entry still means "nothing here knows this tag", which is what catches a mis-written
   * sticker, and covering it with the default would throw that indicator away.
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

    const own =
      entryHasOwnVideo(entry) && fileIsPlayable(this.mediaDir, entry.filePath)
        ? entry.filePath
        : null;
    if (own) {
      this.start(uri, own, false);
      return;
    }

    // The record is in the library but has nothing of its own to play. Two different reasons, and
    // they get different hints when there is no default to fall back on, because they call for
    // different actions: attach a visualizer, versus re-run the sync that was supposed to move one.
    const fallback = this.playableDefault();
    const noVisualizer = !entryHasOwnVideo(entry);
    if (fallback) {
      this.log.warn(
        { uri, filePath: entry.filePath ?? null, defaultVisualizer: fallback },
        noVisualizer
          ? "record has no visualizer of its own — playing the default"
          : "video file missing or outside media dir — playing the default",
      );
      this.start(uri, fallback, true);
      return;
    }

    this.log.warn(
      {
        uri,
        filePath: entry.filePath ?? null,
        defaultVisualizer: this.defaultVisualizerPath,
      },
      noVisualizer
        ? "record has no visualizer and no default clip is playable — staying put"
        : "video file missing or outside media dir, and no default clip is playable — staying put",
    );
    this.hub.broadcast({
      type: "show-message",
      // `video not in library` stays reserved for an *absent* entry (backdrop-spec §10) — this
      // record is in the library, so saying otherwise would send you looking in the wrong place.
      text: noVisualizer ? "no visualizer yet" : "video file missing",
      durationMs: 4000,
    });
  }

  /** The default clip, if one is configured and actually playable right now. */
  private playableDefault(): string | null {
    if (!this.defaultVisualizerPath) return null;
    return fileIsPlayable(this.mediaDir, this.defaultVisualizerPath)
      ? this.defaultVisualizerPath
      : null;
  }

  /** Put a clip on screen. Commits state before the browser finishes fading (spec §7). */
  private start(uri: string, filePath: string, usingDefault: boolean): void {
    // Commit to the new URI before the browser finishes fading, so a rapid third scan wins cleanly
    // (spec §7 "backend commits to the new URI before the fade completes").
    this.state = "playing";
    this.uri = uri;
    this.filePath = filePath;
    this.usingDefault = usingDefault;
    this.since = this.now();
    this.hub.broadcast({ type: "play", filePath });
    this.armIdleTimeout();
  }

  /** Fade to idle. Idempotent — a `stop` while already idle is a no-op beyond re-broadcasting. */
  stop(): void {
    this.clearIdleTimeout();
    this.state = "idle";
    this.uri = null;
    this.filePath = null;
    this.usingDefault = false;
    this.since = this.now();
    this.hub.broadcast({ type: "stop" });
  }

  /** Cancel any pending idle timer (e.g. on shutdown / test teardown). */
  dispose(): void {
    this.clearIdleTimeout();
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
