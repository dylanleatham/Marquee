// A fake Hue driver for tests — implements the HueDriver port the adapter depends on, so
// the adapter's logic (retry loop, per-light iteration, mapping) is exercised with no real
// bridge. See testing-strategy §3.1 (fake at a genuine boundary).
import type { HueApi, LightState } from "node-hue-api";
import type { HueDriver, DiscoveredBridge } from "../src/bridge/adapter.js";
import type { Timers } from "../src/playback/engine.js";

/** Flush the microtask queue so an engine tick's awaited light commands land before we assert. */
export const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Controllable timers for the playback engine: records every scheduled interval so a test can fire
 * the one it cares about by its period. The engine only ever runs one pattern interval per room
 * (plus the 90-minute idle timer, which tests never reach), so firing by `ms` is unambiguous.
 */
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

  /** Fire every live interval whose period is `ms`, `times` times, flushing awaits between each. */
  async tick(ms: number, times = 1): Promise<void> {
    for (let n = 0; n < times; n++) {
      for (const h of this.handlers.values())
        if (!h.cleared && h.ms === ms) h.fn();
      await flush();
    }
  }

  /** Count of live (uncleared) intervals at a given period — asserts a pattern is/ isn't scheduled. */
  activeAt(ms: number): number {
    let n = 0;
    for (const h of this.handlers.values()) if (!h.cleared && h.ms === ms) n++;
    return n;
  }
}

export interface SetCall {
  lightId: string;
  on: boolean;
  rgb: [number, number, number] | null;
  bri: number | null;
  xy: [number, number] | null;
  transitionMs: number | null;
}

class FakeLightState {
  _on = false;
  _rgb: [number, number, number] | null = null;
  _bri: number | null = null;
  _xy: [number, number] | null = null;
  _transitionMs: number | null = null;
  on() {
    this._on = true;
    return this;
  }
  off() {
    this._on = false;
    return this;
  }
  rgb(r: number, g: number, b: number) {
    this._rgb = [r, g, b];
    return this;
  }
  xy(x: number, y: number) {
    this._xy = [x, y];
    return this;
  }
  brightness(percent: number) {
    this._bri = percent;
    return this;
  }
  transitionInMillis(ms: number) {
    this._transitionMs = ms;
    return this;
  }
}

export interface FakeLightStateValue {
  on: boolean;
  bri?: number;
  xy?: [number, number];
}

export interface FakeOptions {
  bridgeId?: string;
  groups?: Array<{ id: string; name: string; type: string; lights: string[] }>;
  lights?: Array<{ id: string; name: string; type: string }>;
  /** Current live state per light id, served by getLightState (drives snapshot tests). */
  lightStates?: Record<string, FakeLightStateValue>;
  /** getLightState never resolves — simulates a wedged bridge for the timeout test. */
  hangLightState?: boolean;
  /** createUser throws "link button not pressed" this many times before succeeding. */
  linkButtonFailuresBeforeSuccess?: number;
  /** createUser never succeeds (pairing-timeout test). */
  createUserAlwaysFails?: boolean;
  /** getConfiguration throws — simulates a paired-but-unreachable bridge. */
  configThrows?: boolean;
  /**
   * `connect` throws — the bridge is powered off or off the network, so *every* call the adapter
   * makes fails, not just `getConfiguration`. Flip it back with `setUnreachable(false)` to prove the
   * §9 "auto: retry next scan" recovery.
   */
  connectThrows?: boolean;
}

export function makeFakeDriver(opts: FakeOptions = {}) {
  const setCalls: SetCall[] = [];
  const groups = opts.groups ?? [];
  let createUserCalls = 0;
  let unreachable = opts.connectThrows ?? false;

  const api = {
    users: {
      async createUser() {
        createUserCalls++;
        const stillFailing =
          opts.createUserAlwaysFails ||
          createUserCalls <= (opts.linkButtonFailuresBeforeSuccess ?? 0);
        if (stillFailing) {
          const err = new Error("link button not pressed") as Error & {
            getHueErrorType(): number;
          };
          err.getHueErrorType = () => 101;
          throw err;
        }
        return { username: "app-key-123", clientkey: "DEADBEEF00" };
      },
    },
    configuration: {
      async getConfiguration() {
        if (opts.configThrows) throw new Error("bridge unreachable");
        return { bridgeid: opts.bridgeId ?? "BID123" };
      },
    },
    groups: {
      async getAll() {
        return groups;
      },
      async getGroup(id: string | number) {
        const g = groups.find((x) => x.id === String(id));
        if (!g) throw new Error(`no group ${id}`);
        return g;
      },
    },
    lights: {
      async getAll() {
        return opts.lights ?? [];
      },
      async getLightState(id: string | number) {
        if (opts.hangLightState) return new Promise<never>(() => {}); // never resolves
        return opts.lightStates?.[String(id)] ?? { on: true, bri: 200 };
      },
      async setLightState(id: string | number, state: FakeLightState) {
        setCalls.push({
          lightId: String(id),
          on: state._on,
          rgb: state._rgb,
          bri: state._bri,
          xy: state._xy,
          transitionMs: state._transitionMs,
        });
        return true;
      },
    },
  };

  const driver: HueDriver = {
    async discover(): Promise<DiscoveredBridge[]> {
      return [
        { id: opts.bridgeId ?? "BID123", ip: "10.0.0.5", name: "Fake Bridge" },
      ];
    },
    async connect() {
      if (unreachable) throw new Error("connect ECONNREFUSED 10.0.0.5:443");
      return api as unknown as HueApi;
    },
    newLightState() {
      return new FakeLightState() as unknown as LightState;
    },
  };

  return {
    driver,
    setCalls,
    getCreateUserCalls: () => createUserCalls,
    /** Take the bridge off the network mid-test, or put it back. */
    setUnreachable: (v: boolean) => {
      unreachable = v;
    },
  };
}
