// A fake Hue driver for tests — implements the HueDriver port the adapter depends on, so
// the adapter's logic (retry loop, per-light iteration, mapping) is exercised with no real
// bridge. See testing-strategy §3.1 (fake at a genuine boundary).
import type { HueApi, LightState } from "node-hue-api";
import type { HueDriver, DiscoveredBridge } from "../src/bridge/adapter.js";

export interface SetCall {
  lightId: string;
  on: boolean;
  rgb: [number, number, number] | null;
}

class FakeLightState {
  _on = false;
  _rgb: [number, number, number] | null = null;
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
  xy() {
    return this;
  }
  brightness() {
    return this;
  }
  transitionInMillis() {
    return this;
  }
}

export interface FakeOptions {
  bridgeId?: string;
  groups?: Array<{ id: string; name: string; type: string; lights: string[] }>;
  lights?: Array<{ id: string; name: string; type: string }>;
  /** createUser throws "link button not pressed" this many times before succeeding. */
  linkButtonFailuresBeforeSuccess?: number;
  /** createUser never succeeds (pairing-timeout test). */
  createUserAlwaysFails?: boolean;
}

export function makeFakeDriver(opts: FakeOptions = {}) {
  const setCalls: SetCall[] = [];
  const groups = opts.groups ?? [];
  let createUserCalls = 0;

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
        return { username: "app-key-123" };
      },
    },
    configuration: {
      async getConfiguration() {
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
      async setLightState(id: string | number, state: FakeLightState) {
        setCalls.push({ lightId: String(id), on: state._on, rgb: state._rgb });
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
      return api as unknown as HueApi;
    },
    newLightState() {
      return new FakeLightState() as unknown as LightState;
    },
  };

  return { driver, setCalls, getCreateUserCalls: () => createUserCalls };
}
