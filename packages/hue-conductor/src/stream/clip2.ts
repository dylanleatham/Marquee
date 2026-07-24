// A tiny CLIP v2 client for the two things the Entertainment path needs that node-hue-api v4 (CLIP
// v1) doesn't give us (ADR 0024): discovering *entertainment configurations* (their id, name, and
// per-channel positions) and flipping one into/out of streaming mode. Everything else still goes
// through the existing BridgeAdapter.
//
// The HTTP call is injected (`Clip2Request`) so the parsing and start/stop logic are unit-tested
// without a bridge; `httpsClip2Request` is the production implementation.
import { request as httpsRequest } from "node:https";

/** One channel in an entertainment area: its bridge channel id and room position (Hue xyz, -1..1). */
export interface EntertainmentChannel {
  channel: number;
  x: number;
  y: number;
  z: number;
}

/** An entertainment area (a Hue "entertainment_configuration") — distinct from a Room. */
export interface EntertainmentArea {
  id: string;
  name: string;
  channels: EntertainmentChannel[];
}

export interface Clip2Result {
  status: number;
  json: unknown;
}

/** Performs one CLIP v2 request. Injected so tests never touch the network. */
export type Clip2Request = (opts: {
  method: "GET" | "PUT";
  path: string;
  body?: unknown;
}) => Promise<Clip2Result>;

/**
 * Real CLIP v2 transport over HTTPS to the LAN bridge. The bridge presents a Signify-signed cert
 * whose CN is the bridge id, not the IP (conductor-spec §11 "known gotchas"); on the trusted LAN we
 * skip verification rather than ship the Signify CA — same posture as the "prevent accidents, not
 * attackers" auth model (runtime-overview §8). Bounded by a timeout so a wedged bridge can't hang.
 */
export function httpsClip2Request(bridge: {
  ip: string;
  applicationKey: string;
  timeoutMs?: number;
}): Clip2Request {
  return ({ method, path, body }) =>
    new Promise<Clip2Result>((resolve, reject) => {
      const payload = body != null ? JSON.stringify(body) : undefined;
      const req = httpsRequest(
        {
          host: bridge.ip,
          path,
          method,
          rejectUnauthorized: false, // LAN bridge, self-signed cert (see doc above)
          headers: {
            "hue-application-key": bridge.applicationKey,
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }
              : {}),
          },
          timeout: bridge.timeoutMs ?? 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            let json: unknown = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("CLIP v2 request timed out")),
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

const RESOURCE = "/clip/v2/resource/entertainment_configuration";

interface Clip2AreaData {
  id?: string;
  metadata?: { name?: string };
  channels?: Array<{
    channel_id?: number;
    position?: { x?: number; y?: number; z?: number };
  }>;
}

export class Clip2Client {
  constructor(private readonly request: Clip2Request) {}

  /** List the bridge's entertainment areas, with each channel's id and position. */
  async listEntertainmentAreas(): Promise<EntertainmentArea[]> {
    const res = await this.request({ method: "GET", path: RESOURCE });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `CLIP v2 list entertainment areas failed: HTTP ${res.status}`,
      );
    }
    const data = (res.json as { data?: Clip2AreaData[] } | null)?.data ?? [];
    return data.map((a) => ({
      id: a.id ?? "",
      name: a.metadata?.name ?? "",
      channels: (a.channels ?? []).map((c) => ({
        channel: c.channel_id ?? 0,
        x: c.position?.x ?? 0,
        y: c.position?.y ?? 0,
        z: c.position?.z ?? 0,
      })),
    }));
  }

  /** Put an entertainment area into (or out of) streaming mode. Must be `start`ed before DTLS frames. */
  async setStreaming(areaId: string, on: boolean): Promise<void> {
    const res = await this.request({
      method: "PUT",
      path: `${RESOURCE}/${areaId}`,
      body: { action: on ? "start" : "stop" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `CLIP v2 ${on ? "start" : "stop"} streaming failed: HTTP ${res.status}`,
      );
    }
  }
}
