// Test doubles for Amp. FakeSonosDriver records play/stop calls (mirrors hue-conductor's
// makeFakeDriver — a fake at the genuine hardware boundary), and FakeTimers makes the idle timeout
// deterministic. Per testing-strategy §3.1, a fake needs its own tests — FakeSonosDriver is exercised
// indirectly by every scan test here.
import type { SonosDriver } from "../src/sonos/driver.js";
import type { Timers } from "../src/playback/engine.js";

/** Controllable timers: records scheduled timeouts so a test can fire one by its period. */
export class FakeTimers implements Timers {
  private readonly handlers = new Map<
    number,
    { fn: () => void; ms: number; cleared: boolean }
  >();
  private nextId = 1;

  set(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.handlers.set(id, { fn, ms, cleared: false });
    return id;
  }

  clear(handle: unknown): void {
    const h = this.handlers.get(handle as number);
    if (h) h.cleared = true;
  }

  /** Fire every live timer whose period is `ms`. */
  fire(ms: number): void {
    for (const h of this.handlers.values())
      if (!h.cleared && h.ms === ms) h.fn();
  }

  /** Count of live (uncleared) timers at a given period. */
  activeAt(ms: number): number {
    let n = 0;
    for (const h of this.handlers.values()) if (!h.cleared && h.ms === ms) n++;
    return n;
  }
}

export interface PlayCall {
  target: string;
  spotifyUri: string;
}

export interface FakeSonosOptions {
  rooms?: string[];
  /** If set, play() rejects with this error (e.g. a SonosUnavailableError for the degrade test). */
  failPlay?: Error;
}

export class FakeSonosDriver implements SonosDriver {
  readonly playCalls: PlayCall[] = [];
  readonly stopCalls: string[] = [];

  constructor(private readonly opts: FakeSonosOptions = {}) {}

  async play(target: string, spotifyUri: string): Promise<void> {
    if (this.opts.failPlay) throw this.opts.failPlay;
    this.playCalls.push({ target, spotifyUri });
  }

  async stop(target: string): Promise<void> {
    this.stopCalls.push(target);
  }

  async rooms(): Promise<string[]> {
    return this.opts.rooms ?? [];
  }
}
