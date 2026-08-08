// Outbound HTTP to Conductor's album-asset ingest API (ADR 0045, conductor-spec §8). Curator owns the
// album-assets store; Conductor reads a synced copy of it at scan time. Until this existed the copy
// moved only by a hand-run `rsync`, so the runtime silently drifted behind the workstation — every
// scan answering `202 ignored: album not synced` while Curator reported the album healthy.
//
// Deliberately a sibling of `backdrop/client.ts` rather than a reuse of the `callConductor` helper in
// server.ts: that one is an untyped pass-through proxy for the Demo Room, which replays whatever
// Conductor says straight to the browser. This is a typed sync client whose failures have to become
// syncIssues on an album.
import type { AlbumAsset } from "../albums/asset.js";
import { describeFetchFailure } from "../net/fetch-failure.js";

type FetchImpl = typeof fetch;

export interface ConductorClientOptions {
  /** Base URL of the Conductor service, e.g. http://runtime-pi:4737. */
  url: string;
  /** The shared secret sent as X-Trigger-Secret; omit only if Conductor runs with auth disabled. */
  sharedSecret?: string;
  /** Per-request timeout (ms). Default 5s, matching the Backdrop client and the demo proxy. */
  timeoutMs?: number;
  /** Injected fetch (tests). Defaults to the global. */
  fetchImpl?: FetchImpl;
}

/** Conductor returned a non-2xx status for a sync call. */
export class ConductorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConductorError";
  }
}

export class ConductorClient {
  private readonly url: string;
  private readonly sharedSecret?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: ConductorClientOptions) {
    this.url = opts.url.replace(/\/+$/, ""); // no trailing slash so path joins are clean
    this.sharedSecret = opts.sharedSecret;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    // Only declare a JSON content-type when we actually send a body — a bodyless GET with
    // `content-type: application/json` trips Fastify's FST_ERR_CTP_EMPTY_JSON_BODY (400).
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.sharedSecret) headers["x-trigger-secret"] = this.sharedSecret;
    // Describe a transport failure here so every caller inherits a message naming Conductor and the
    // address. This throw becomes an album's syncIssue and a job's `error`, both of which used to
    // carry the transport's wording alone (issue #270).
    let res;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `Conductor ${init.method} ${path}: ${describeFetchFailure(err, this.url, this.timeoutMs)}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ConductorError(
        res.status,
        `Conductor ${init.method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res.json().catch(() => ({}));
  }

  /**
   * Push one album's asset (`PUT /api/album-assets/:curatorId`).
   *
   * The whole asset goes, not a projection. Conductor reads a documented slice (`AlbumPaletteInput`)
   * and Amp reads a different one, so narrowing here would mean deciding for both — and the file on
   * the runtime is meant to be the same file that's on the workstation, which is what makes a diff
   * of the two meaningful.
   */
  async putAsset(asset: AlbumAsset): Promise<void> {
    await this.call(
      `/api/album-assets/${encodeURIComponent(asset.curatorId)}`,
      { method: "PUT", body: asset },
    );
  }

  /** The curatorIds Conductor currently holds (`GET /api/album-assets`) — used by verify. */
  async listAssets(): Promise<string[]> {
    const res = (await this.call("/api/album-assets", { method: "GET" })) as {
      curatorIds?: unknown;
    };
    return Array.isArray(res.curatorIds)
      ? res.curatorIds.filter((id): id is string => typeof id === "string")
      : [];
  }
}
