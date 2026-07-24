// The streaming clock (hue-conductor-spec §9). Given a `StreamRenderer`, the engine samples it at a
// fixed frame rate (~25 Hz) and pushes each frame to a `StreamTransport`. Timers and the clock are
// injected so tests can step frames deterministically, exactly like the CLIP `PlaybackEngine` does.
//
// The transport is a seam: `FakeStreamTransport` (here) records frames for tests and the preview; the
// real DTLS/UDP transport to the bridge's entertainment area is the hardware follow-up (ADR 0023) and
// is intentionally not in this package yet.
import type { StreamFrame, StreamRenderer } from "./types.js";

/** Where rendered frames go. Fire-and-forget per frame — streaming tolerates a dropped frame. */
export interface StreamTransport {
  /** Push one frame toward the lights. Must not throw on a single bad frame. */
  send(frame: StreamFrame): void;
  /** Release the underlying connection; no further `send`s will arrive. */
  close(): void;
}

/** An in-memory transport that records every frame — for tests and the offline preview. */
export class FakeStreamTransport implements StreamTransport {
  readonly frames: StreamFrame[] = [];
  private closed = false;

  send(frame: StreamFrame): void {
    if (!this.closed) this.frames.push(frame);
  }

  close(): void {
    this.closed = true;
  }
}

/** Injectable interval timer — production uses setInterval; tests capture the callback and step it. */
export interface StreamTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realStreamTimers: StreamTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_FPS = 25;
/** Hard ceiling so a bad config can't spin the loop into a tight busy-send. */
const MAX_FPS = 60;

export interface StreamEngineOptions {
  timers?: StreamTimers;
  now?: () => number;
  /** Frames per second (clamped to 1..60). Default 25 — the Entertainment API's practical rate. */
  fps?: number;
}

export class StreamEngine {
  private readonly timers: StreamTimers;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: unknown | null = null;
  private renderer: StreamRenderer | null = null;
  private startedAt = 0;

  constructor(
    private readonly transport: StreamTransport,
    opts: StreamEngineOptions = {},
  ) {
    this.timers = opts.timers ?? realStreamTimers;
    this.now = opts.now ?? Date.now;
    const fps = Math.min(
      MAX_FPS,
      Math.max(1, Math.round(opts.fps ?? DEFAULT_FPS)),
    );
    this.intervalMs = Math.round(1000 / fps);
  }

  /** True while frames are being streamed. */
  get isPlaying(): boolean {
    return this.timer != null;
  }

  /** The frame interval in ms (1000 / fps), after clamping. */
  get frameIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * Start streaming `renderer`. Emits the t=0 frame immediately (so the room reacts without waiting a
   * frame), then one frame per interval with `tMs` measured from the start. Calling `play` again
   * swaps the renderer and restarts the clock.
   */
  play(renderer: StreamRenderer): void {
    this.stopTimer();
    this.renderer = renderer;
    this.startedAt = this.now();
    this.emit(renderer, 0);
    this.timer = this.timers.set(() => {
      const r = this.renderer;
      if (r) this.emit(r, this.now() - this.startedAt);
    }, this.intervalMs);
  }

  /**
   * Render and send one frame, swallowing any error. The interval callback is otherwise unguarded,
   * so a throwing transport — e.g. the real DTLS transport hitting a network hiccup (ADR 0023) — must
   * not escape and crash this always-on service; drop the frame and the next tick recovers. Mirrors
   * the CLIP `PlaybackEngine`'s per-tick `.catch()`.
   */
  private emit(renderer: StreamRenderer, tMs: number): void {
    try {
      this.transport.send(renderer.frame(tMs));
    } catch {
      // Frame dropped — streaming tolerates it; the next interval sends a fresh one.
    }
  }

  /** Stop streaming and close the transport. Idempotent. */
  stop(): void {
    this.stopTimer();
    this.renderer = null;
    this.transport.close();
  }

  private stopTimer(): void {
    if (this.timer != null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
