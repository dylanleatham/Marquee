// Orchestrates one streaming-effect session end to end (ADR 0024), the streaming counterpart to the
// CLIP `PlaybackEngine`. Start: snapshot the room (CLIP), put the entertainment area into streaming
// mode (CLIP v2), open the DTLS session, and run the effect through a `StreamEngine`. Stop: halt the
// engine (which closes the socket), leave streaming mode, and restore the pre-session snapshot — the
// same non-destructive contract as CLIP playback. All collaborators are injected so the ordering is
// unit-testable without a bridge; the only unverifiable piece off-hardware is the DTLS handshake.
import { StreamEngine, realStreamTimers, type StreamTimers } from "./engine.js";
import { DtlsStreamTransport, type DtlsSocket } from "./dtls-transport.js";
import { buildStreamRenderer, type StreamEffect } from "./renderers.js";
import type { StreamLight } from "./types.js";
import type { EntertainmentArea } from "./clip2.js";
import type { RoomSnapshot } from "../bridge/adapter.js";

/** Snapshot/restore of a room's CLIP state — satisfied by `BridgeAdapter`. */
export interface RoomStatePort {
  snapshotRoom(roomId: string): Promise<RoomSnapshot>;
  restoreRoom(
    roomId: string,
    snapshot: RoomSnapshot,
    transitionMs: number,
  ): Promise<void>;
}

/** Entertainment-area control — satisfied by `Clip2Client`. */
export interface StreamControlPort {
  listEntertainmentAreas(): Promise<EntertainmentArea[]>;
  setStreaming(areaId: string, on: boolean): Promise<void>;
}

export interface StreamSessionOptions {
  timers?: StreamTimers;
  now?: () => number;
  fps?: number;
  idleTimeoutMs?: number;
  /** Fade time for the CLIP restore on stop. */
  restoreMs?: number;
}

const STOP_TRANSITION_MS = 800;

interface Active {
  roomId: string;
  areaId: string;
  snapshot: RoomSnapshot;
  engine: StreamEngine;
  idleTimer: unknown | null;
}

/** One active streaming session at a time (there is a single configured entertainment area). */
export class StreamSession {
  private active: Active | null = null;
  private readonly timers: StreamTimers;
  private readonly idleTimeoutMs: number;
  private readonly restoreMs: number;

  constructor(
    private readonly rooms: RoomStatePort,
    private readonly control: StreamControlPort,
    /** Opens a DTLS session to the area; the hardware-verified seam (see dtls-transport.ts). */
    private readonly connect: (area: EntertainmentArea) => Promise<DtlsSocket>,
    private readonly opts: StreamSessionOptions = {},
  ) {
    this.timers = opts.timers ?? realStreamTimers;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 90 * 60 * 1000;
    this.restoreMs = opts.restoreMs ?? STOP_TRANSITION_MS;
  }

  isStreaming(): boolean {
    return this.active != null;
  }

  /**
   * Start a streaming effect on `roomId` using entertainment area `areaId`. Any already-active session
   * is stopped first (a sleeve swap). Throws if the area isn't found or a step fails — the caller
   * should fall back to the CLIP path and log (a scan must not error-storm the service).
   */
  async start(
    roomId: string,
    areaId: string,
    effect: StreamEffect,
    hexes: string[],
    params: Record<string, number> = {},
  ): Promise<void> {
    if (this.active) await this.stop();

    const area = (await this.control.listEntertainmentAreas()).find(
      (a) => a.id === areaId,
    );
    if (!area) throw new Error(`entertainment area not found: ${areaId}`);

    // Snapshot before we take over the lights, so stop() can put the room back (conductor-spec §9).
    const snapshot = await this.rooms.snapshotRoom(roomId);
    await this.control.setStreaming(areaId, true);

    let engine: StreamEngine;
    try {
      const socket = await this.connect(area);
      const transport = new DtlsStreamTransport(socket, areaId);
      const lights: StreamLight[] = area.channels.map((c) => ({
        id: String(c.channel),
        x: c.x,
        y: c.y,
      }));
      engine = new StreamEngine(transport, {
        timers: this.timers,
        now: this.opts.now,
        fps: this.opts.fps,
      });
      engine.play(buildStreamRenderer(effect, lights, hexes, params));
    } catch (err) {
      // Handshake/connect failed after we entered streaming mode — back it out and restore.
      await this.control.setStreaming(areaId, false).catch(() => {});
      await this.rooms
        .restoreRoom(roomId, snapshot, this.restoreMs)
        .catch(() => {});
      throw err;
    }

    const idleTimer = this.timers.set(() => {
      void this.stop();
    }, this.idleTimeoutMs);
    this.active = { roomId, areaId, snapshot, engine, idleTimer };
  }

  /** Stop streaming: halt the engine (closes the socket), leave streaming mode, restore the room. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.idleTimer) this.timers.clear(active.idleTimer);
    active.engine.stop();
    await this.control.setStreaming(active.areaId, false).catch(() => {});
    await this.rooms.restoreRoom(
      active.roomId,
      active.snapshot,
      this.restoreMs,
    );
  }
}
