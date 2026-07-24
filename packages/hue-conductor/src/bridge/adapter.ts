import { request as httpsRequest } from "node:https";
import hue from "node-hue-api";
import type { HueApi, HueGroup, LightState } from "node-hue-api";
import { hexToRgb } from "../color.js";
import type { Store, BridgeRecord } from "../store.js";

/**
 * Map the raw CLIP v1 `/groups` response (a `{ [id]: group }` object) to the group shape `getRooms`
 * needs, leniently. Used as a fallback when node-hue-api's validating `getAll()` throws on a group
 * class it doesn't know — notably a "Free" entertainment area (ADR 0024). Entries without a string
 * `name` (e.g. an error array the bridge returns on failure) are skipped. Pure, for testing.
 */
export function mapV1Groups(json: unknown): HueGroup[] {
  if (!json || typeof json !== "object") return [];
  return Object.entries(json as Record<string, unknown>)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        !!entry[1] &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]) &&
        typeof (entry[1] as { name?: unknown }).name === "string",
    )
    .map(([id, g]) => ({
      id,
      name: g.name as string,
      type: String(g.type ?? ""),
      lights: Array.isArray(g.lights)
        ? (g.lights as unknown[]).map(String)
        : [],
    }));
}

export interface DiscoveredBridge {
  id: string | null;
  ip: string;
  name?: string;
}

export interface RoomInfo {
  id: string;
  name: string;
  type: string;
  lightIds: string[];
  colorCapable: boolean;
}

export interface LightInfo {
  id: string;
  name: string;
  type: string;
  colorCapable: boolean;
}

/** One light's captured state (conductor-spec §9 restoration). `bri` is Hue's 0–254 scale. */
export interface LightSnapshot {
  on: boolean;
  bri?: number;
  xy?: [number, number];
}

/** A room's captured lighting, keyed by light id — restored verbatim on `stop`. */
export interface RoomSnapshot {
  lights: Record<string, LightSnapshot>;
}

/**
 * The only surface the adapter needs from node-hue-api. Injecting this (rather than
 * importing the library directly everywhere) is what makes the adapter testable without a
 * real bridge — tests pass a fake driver. `nodeHueDriver` is the production implementation.
 */
export interface HueDriver {
  discover(): Promise<DiscoveredBridge[]>;
  connect(ip: string, username?: string): Promise<HueApi>;
  newLightState(): LightState;
}

export const nodeHueDriver: HueDriver = {
  async discover() {
    const found = new Map<string, DiscoveredBridge>();
    // Local mDNS/SSDP first, then the cloud N-UPnP fallback. A failing method isn't fatal.
    const methods = [
      () => hue.v3.discovery.upnpSearch(5000),
      () => hue.v3.discovery.nupnpSearch(),
    ];
    for (const search of methods) {
      try {
        for (const b of await search()) {
          if (!b.ipaddress || found.has(b.ipaddress)) continue;
          found.set(b.ipaddress, {
            ip: b.ipaddress,
            id: b.config?.bridgeid ?? b.id ?? null,
            name: b.config?.name,
          });
        }
      } catch {
        // no internet for nupnp, or no mDNS responder — try the next method
      }
    }
    return [...found.values()];
  },
  connect: (ip, username) => hue.v3.api.createLocal(ip).connect(username),
  newLightState: () => new hue.v3.lightStates.LightState(),
};

export class NotPairedError extends Error {
  constructor() {
    super(
      "No Hue bridge paired. Run `pnpm --filter @marquee/hue-conductor pair` on the Pi.",
    );
    this.name = "NotPairedError";
  }
}

/**
 * Wraps the Hue driver with Marquee's semantics. This is the one place that knows the Hue
 * library exists (conductor-spec §5); keeping it thin is what lets us swap transports later
 * (e.g. the Entertainment API for streaming).
 */
export class BridgeAdapter {
  private connected: HueApi | null = null;

  constructor(
    private readonly store: Store,
    private readonly driver: HueDriver = nodeHueDriver,
  ) {}

  discover(): Promise<DiscoveredBridge[]> {
    return this.driver.discover();
  }

  /**
   * Poll the bridge until the physical link button is pressed (or timeout), then persist
   * the application key. A new key is created on each successful pairing.
   */
  async pair(
    ip: string,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<BridgeRecord> {
    const attempts = opts.attempts ?? 30;
    const intervalMs = opts.intervalMs ?? 2000;
    const unauth = await this.driver.connect(ip);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const created = await unauth.users.createUser(
          "marquee",
          "hue-conductor",
        );
        const authed = await this.driver.connect(ip, created.username);
        const cfg = await authed.configuration.getConfiguration();
        const record: BridgeRecord = {
          id: cfg.bridgeid ?? "unknown",
          ip,
          applicationKey: created.username,
          // The DTLS PSK for Entertainment streaming (ADR 0024). The bridge only hands this out at
          // user-creation time, so pairing is the one chance to capture it.
          ...(created.clientkey ? { clientkey: created.clientkey } : {}),
          pairedAt: new Date().toISOString(),
        };
        this.store.saveBridge(record);
        this.connected = authed;
        return record;
      } catch (err) {
        if (isLinkButtonNotPressed(err)) {
          await sleep(intervalMs);
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      "Timed out waiting for the bridge link button to be pressed.",
    );
  }

  async status(): Promise<
    | { paired: false }
    | {
        paired: true;
        bridgeId: string;
        ip: string;
        pairedAt: string;
        reachable: boolean;
      }
  > {
    const b = this.store.bridge;
    if (!b) return { paired: false };
    let reachable = false;
    try {
      const api = await this.api();
      await api.configuration.getConfiguration();
      reachable = true;
    } catch {
      reachable = false;
    }
    return {
      paired: true,
      bridgeId: b.id,
      ip: b.ip,
      pairedAt: b.pairedAt,
      reachable,
    };
  }

  async getRooms(): Promise<RoomInfo[]> {
    const api = await this.api();
    let groups: HueGroup[];
    try {
      groups = await api.groups.getAll();
    } catch {
      // node-hue-api v4 rejects the whole batch on a group class it doesn't know — notably a "Free"
      // entertainment area, which the streaming setup asks you to create (ADR 0024). Fall back to the
      // raw CLIP v1 groups endpoint, parsed leniently, so room listing survives it.
      groups = await this.getGroupsRawV1();
    }
    return groups
      .filter((g) => g.type === "Room" || g.type === "Zone")
      .map((g) => ({
        id: String(g.id),
        name: g.name,
        type: g.type,
        lightIds: (g.lights ?? []).map(String),
        colorCapable: true,
      }));
  }

  /** Raw CLIP v1 groups fetch — the fallback for `getRooms` (see there). Hardware-only path. */
  private getGroupsRawV1(): Promise<HueGroup[]> {
    const b = this.store.bridge;
    if (!b) throw new NotPairedError();
    return new Promise<HueGroup[]>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: b.ip,
          path: `/api/${b.applicationKey}/groups`,
          method: "GET",
          rejectUnauthorized: false, // LAN bridge, self-signed cert (conductor-spec §11)
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(mapV1Groups(JSON.parse(data)));
            } catch (e) {
              reject(e as Error);
            }
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("groups request timed out")),
      );
      req.on("error", reject);
      req.end();
    });
  }

  async getLights(): Promise<LightInfo[]> {
    const api = await this.api();
    const lights = await api.lights.getAll();
    return lights.map((l) => ({
      id: String(l.id),
      name: l.name,
      type: l.type,
      colorCapable: /color/i.test(l.type),
    }));
  }

  /**
   * Set a flat color across every light in a room. Addresses lights individually rather
   * than as a group, which avoids the 1 Hz group-command limit (conductor-spec §9).
   */
  async setRoomColor(
    roomId: string,
    hex: string,
  ): Promise<{ lightsSet: number }> {
    const ids = await this.getRoomLightIds(roomId);
    for (const id of ids) await this.setLightColor(id, hex);
    return { lightsSet: ids.length };
  }

  /** The light ids belonging to a room/zone. The playback engine caches these per session. */
  async getRoomLightIds(roomId: string): Promise<string[]> {
    const api = await this.api();
    const group = await api.groups.getGroup(roomId);
    return (group.lights ?? []).map(String);
  }

  /**
   * Set one light's color, optionally with a brightness (0–100) and a fade time. The fade is the
   * bridge's own `transitiontime` — cheap and smooth, so the playback engine's crossfades don't
   * have to interpolate in software (conductor-spec §9).
   */
  async setLightColor(
    lightId: string,
    hex: string,
    opts: { brightnessPct?: number; transitionMs?: number } = {},
  ): Promise<void> {
    const api = await this.api();
    const { r, g, b } = hexToRgb(hex);
    let state = this.driver.newLightState().on().rgb(r, g, b);
    if (opts.brightnessPct != null)
      state = state.brightness(opts.brightnessPct);
    if (opts.transitionMs != null)
      state = state.transitionInMillis(opts.transitionMs);
    await api.lights.setLightState(lightId, state);
  }

  /**
   * Capture the current on/color/brightness of every light in a room, so a playback session can
   * put the room back exactly as it found it when the sleeve is lifted (conductor-spec §9 state
   * restoration). Unreachable lights are captured as best-effort `off`.
   */
  async snapshotRoom(roomId: string): Promise<RoomSnapshot> {
    const api = await this.api();
    const ids = await this.getRoomLightIds(roomId);
    const lights: Record<string, LightSnapshot> = {};
    for (const id of ids) {
      try {
        const s = await api.lights.getLightState(id);
        lights[id] = { on: s.on, bri: s.bri, xy: s.xy };
      } catch {
        lights[id] = { on: false };
      }
    }
    return { lights };
  }

  /** Fade a room back to a previously captured snapshot over `transitionMs`. */
  async restoreRoom(
    roomId: string,
    snapshot: RoomSnapshot,
    transitionMs: number,
  ): Promise<void> {
    const api = await this.api();
    for (const [id, snap] of Object.entries(snapshot.lights)) {
      let state = this.driver.newLightState();
      if (!snap.on) {
        state = state.off().transitionInMillis(transitionMs);
      } else {
        state = state.on();
        if (snap.xy) state = state.xy(snap.xy[0], snap.xy[1]);
        if (snap.bri != null)
          state = state.brightness(Math.round((snap.bri / 254) * 100));
        state = state.transitionInMillis(transitionMs);
      }
      await api.lights.setLightState(id, state);
    }
  }

  private async api(): Promise<HueApi> {
    const b = this.store.bridge;
    if (!b) throw new NotPairedError();
    if (!this.connected)
      this.connected = await this.driver.connect(b.ip, b.applicationKey);
    return this.connected;
  }
}

/** Hue error type 101 = "link button not pressed". */
function isLinkButtonNotPressed(err: unknown): boolean {
  const e = err as { getHueErrorType?: () => number; message?: string };
  try {
    if (typeof e?.getHueErrorType === "function")
      return e.getHueErrorType() === 101;
  } catch {
    // fall through to message sniff
  }
  return /link button/i.test(e?.message ?? "");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
