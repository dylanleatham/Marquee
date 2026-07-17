// The palette+pattern playback engine (conductor-spec §9). Turns a PalettePayload into light
// commands on a room: assign/animate the palette per the pattern, snapshot the room on the first
// start of a session and restore it on stop, and crossfade when a new palette arrives mid-session
// (the "swap sleeves" case). Timers are injected so patterns are deterministic under test; the
// bridge fades between colors using its own transition time, so we never interpolate in software.
import { randomUUID } from "node:crypto";
import type { PalettePayload, PaletteColor } from "@marquee/contracts";
import type { BridgeAdapter, RoomSnapshot } from "../bridge/adapter.js";
import { RateLimiter } from "./rate-limit.js";

/** Injectable timer port — production uses setInterval; tests capture the callback and step it. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Default crossfade for a palette arriving (first start or swap) — spec §9 "deliberate, not jarring". */
const SWAP_TRANSITION_MS = 1500;
/** Fade time when a session stops and the room restores to its pre-session snapshot. */
const STOP_TRANSITION_MS = 800;
/** Hue's per-light ceiling is ~10/s; keep a little headroom and a small burst. */
const RATE_PER_SEC = 8;
const RATE_BURST = 4;
/** Cap on an awaited bridge call so a wedged (not just offline) bridge can't hang a request. */
const BRIDGE_TIMEOUT_MS = 8000;

/** Reject if `p` doesn't settle within `ms`; clears its timer either way so nothing leaks. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Hue bridge ${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** One command the engine wants to send to one light this frame. */
interface Frame {
  lightId: string;
  hex: string;
  brightnessPct?: number;
  transitionMs?: number;
}

/** A pattern compiled for a fixed set of lights: how often it ticks, and each step's frames. */
interface Plan {
  intervalMs: number | null; // null → static (apply once, no timer)
  frames(step: number): Frame[];
}

interface Session {
  roomId: string;
  lightIds: string[];
  snapshot: RoomSnapshot;
  plan: Plan;
  step: number;
  timer: unknown | null;
  idleTimer: unknown | null;
  playbackId: string;
}

export interface EngineOptions {
  timers?: Timers;
  now?: () => number;
  /** Auto-stop after this long with no new start (safety net for a lost stop event). */
  idleTimeoutMs?: number;
  /** Per-call cap on awaited bridge ops (tests set this tiny). */
  bridgeTimeoutMs?: number;
}

export class PlaybackEngine {
  private readonly sessions = new Map<string, Session>();
  private readonly timers: Timers;
  private readonly rate: RateLimiter;
  private readonly idleTimeoutMs: number;
  private readonly bridgeTimeoutMs: number;

  constructor(
    private readonly bridge: BridgeAdapter,
    opts: EngineOptions = {},
  ) {
    this.timers = opts.timers ?? realTimers;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 90 * 60 * 1000;
    this.bridgeTimeoutMs = opts.bridgeTimeoutMs ?? BRIDGE_TIMEOUT_MS;
    this.rate = new RateLimiter(RATE_PER_SEC, RATE_BURST, opts.now);
  }

  /** True while a room has an active playback session. */
  isPlaying(roomId: string): boolean {
    return this.sessions.has(roomId);
  }

  /**
   * Start (or crossfade to) a palette on a room. The first start snapshots the room so `stop` can
   * restore it; a start while already playing keeps that original snapshot and crossfades to the new
   * palette (spec §9 "palette transitions within a session").
   */
  async start(
    roomId: string,
    payload: PalettePayload,
  ): Promise<{ playbackId: string }> {
    const colors = payload.palette.colors;
    if (colors.length === 0) throw new Error("palette has no colors");

    const existing = this.sessions.get(roomId);
    if (existing?.timer) this.timers.clear(existing.timer);

    // These bridge calls are on the /api/playback request path — cap them so a wedged bridge 502s
    // fast instead of hanging the request (review: runtime).
    const lightIds = await withTimeout(
      this.bridge.getRoomLightIds(roomId),
      this.bridgeTimeoutMs,
      "getRoomLightIds",
    );
    const snapshot =
      existing?.snapshot ??
      (await withTimeout(
        this.bridge.snapshotRoom(roomId),
        this.bridgeTimeoutMs,
        "snapshotRoom",
      ));

    const session: Session = {
      roomId,
      lightIds,
      snapshot,
      plan: compilePlan(payload, lightIds),
      step: 0,
      timer: null,
      idleTimer: existing?.idleTimer ?? null,
      playbackId: existing?.playbackId ?? randomUUID(),
    };
    this.sessions.set(roomId, session);

    // First frame fades in / crossfades over SWAP_TRANSITION_MS (not rate-limited: one cmd per light).
    await withTimeout(
      this.applyFrames(session.plan.frames(0), SWAP_TRANSITION_MS, false),
      this.bridgeTimeoutMs,
      "applyFrames",
    );

    if (session.plan.intervalMs != null) {
      session.timer = this.timers.set(() => {
        session.step += 1;
        void this.tick(session).catch(() => {
          // A dropped/failed light command must not kill the pattern loop — the next tick recovers.
        });
      }, session.plan.intervalMs);
    }
    this.armIdleTimeout(session);
    return { playbackId: session.playbackId };
  }

  /** Stop a room's session: cancel the pattern and fade the room back to its pre-session snapshot. */
  async stop(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session) return;
    if (session.timer) this.timers.clear(session.timer);
    if (session.idleTimer) this.timers.clear(session.idleTimer);
    this.sessions.delete(roomId);
    await withTimeout(
      this.bridge.restoreRoom(roomId, session.snapshot, STOP_TRANSITION_MS),
      this.bridgeTimeoutMs,
      "restoreRoom",
    );
  }

  /** Stop every active session (used on shutdown / test teardown). */
  async stopAll(): Promise<void> {
    for (const roomId of [...this.sessions.keys()]) await this.stop(roomId);
  }

  private async tick(session: Session): Promise<void> {
    // A stop between scheduling and firing leaves the session gone — don't touch the lights.
    if (this.sessions.get(session.roomId) !== session) return;
    await this.applyFrames(session.plan.frames(session.step), undefined, true);
  }

  private async applyFrames(
    frames: Frame[],
    transitionOverrideMs: number | undefined,
    rateLimited: boolean,
  ): Promise<void> {
    for (const f of frames) {
      if (rateLimited && !this.rate.tryTake(f.lightId)) continue;
      await this.bridge.setLightColor(f.lightId, f.hex, {
        brightnessPct: f.brightnessPct,
        transitionMs: transitionOverrideMs ?? f.transitionMs,
      });
    }
  }

  private armIdleTimeout(session: Session): void {
    if (session.idleTimer) this.timers.clear(session.idleTimer);
    session.idleTimer = this.timers.set(() => {
      void this.stop(session.roomId);
    }, this.idleTimeoutMs);
  }
}

// --- pattern compilation ------------------------------------------------------------------------

const mod = (n: number, m: number): number => ((n % m) + m) % m;

const primaryColor = (colors: PaletteColor[]): PaletteColor =>
  colors.find((c) => c.role === "primary") ?? colors[0]!;

/** Compile a payload's pattern into a per-step frame generator over a fixed set of light ids. */
function compilePlan(payload: PalettePayload, lightIds: string[]): Plan {
  const colors = payload.palette.colors;
  const { type, params } = payload.pattern;

  if (type === "rotate") {
    const p = params as {
      intervalMs: number;
      direction: "forward" | "reverse";
    };
    const trans = Math.min(p.intervalMs, 800);
    return {
      intervalMs: p.intervalMs,
      frames: (step) =>
        lightIds.map((lightId, i) => {
          const shift = p.direction === "reverse" ? -step : step;
          return {
            lightId,
            hex: colors[mod(i + shift, colors.length)]!.hex,
            transitionMs: trans,
          };
        }),
    };
  }

  if (type === "pulse") {
    const p = params as {
      periodMs: number;
      minBrightness: number;
      maxBrightness: number;
    };
    const hex = primaryColor(colors).hex;
    const half = Math.max(1, Math.round(p.periodMs / 2));
    return {
      intervalMs: half,
      frames: (step) =>
        lightIds.map((lightId) => ({
          lightId,
          hex,
          brightnessPct: step % 2 === 0 ? p.maxBrightness : p.minBrightness,
          transitionMs: half,
        })),
    };
  }

  if (type === "crossfade") {
    const p = params as { transitionMs: number; holdMs: number };
    return {
      intervalMs: p.holdMs,
      frames: (step) => {
        const hex = colors[mod(step, colors.length)]!.hex;
        return lightIds.map((lightId) => ({
          lightId,
          hex,
          transitionMs: p.transitionMs,
        }));
      },
    };
  }

  // static (and unknown → treat as static): assign colors across the lights once, cycling.
  return {
    intervalMs: null,
    frames: () =>
      lightIds.map((lightId, i) => ({
        lightId,
        hex: colors[mod(i, colors.length)]!.hex,
      })),
  };
}
