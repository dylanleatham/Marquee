// Outbound HTTP to Backdrop's library-sync API (backdrop-spec §8). Curator is the only writer of
// Backdrop's library.json; it pushes updates over the LAN with the shared `X-Trigger-Secret`. Mirrors
// the Conductor call pattern in server.ts: `fetch` (a Node 22 global) with an AbortSignal timeout so a
// wedged Backdrop can't hang the caller. `fetchImpl` is injectable for unit tests.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { LibraryEntry } from "@marquee/contracts";
import type { LibraryEntryWithUri } from "./projection.js";

type FetchImpl = typeof fetch;

export interface BackdropClientOptions {
  /** Base URL of the Backdrop service, e.g. http://backdrop-pi:4740. */
  url: string;
  /** The shared secret sent as X-Trigger-Secret; omit only if Backdrop runs with auth disabled. */
  sharedSecret?: string;
  /** Per-request timeout (ms). Default 5s, matching the Conductor proxy. */
  timeoutMs?: number;
  /**
   * How long a media upload may make **no progress** before it is abandoned (ms, default 60s).
   *
   * Deliberately a stall timeout rather than a deadline. A visualizer is a few hundred MB and the
   * link to a Pi can be poor — one measured at ~44 KB/s, where a real 239 MB file needs ~90 minutes.
   * Any fixed deadline generous enough for that would take an hour to notice a wedged peer, and any
   * deadline short enough to be useful would kill working transfers. What actually distinguishes
   * "slow" from "dead" is whether bytes are still moving (ADR 0038).
   */
  uploadStallMs?: number;
  /** Injected fetch (tests). Defaults to the global. */
  fetchImpl?: FetchImpl;
}

/** Backdrop returned a non-2xx status for a sync call. */
export class BackdropError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BackdropError";
  }
}

/** The current on-disk library, as returned by GET /api/library (backdrop-spec §9). */
export interface BackdropLibrary {
  version: number;
  updatedAt: string;
  entries: Record<string, LibraryEntry>;
}

export class BackdropClient {
  private readonly url: string;
  private readonly sharedSecret?: string;
  private readonly timeoutMs: number;
  private readonly uploadStallMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: BackdropClientOptions) {
    this.url = opts.url.replace(/\/+$/, ""); // no trailing slash so path joins are clean
    this.sharedSecret = opts.sharedSecret;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.uploadStallMs = opts.uploadStallMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    // Only declare a JSON content-type when we actually send a body — a bodyless request (DELETE, GET)
    // with `content-type: application/json` trips Fastify's FST_ERR_CTP_EMPTY_JSON_BODY (400).
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.sharedSecret) headers["x-trigger-secret"] = this.sharedSecret;
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new BackdropError(
        res.status,
        `Backdrop ${init.method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res.json().catch(() => ({}));
  }

  /** Insert or update one album's entry (POST /api/library/update). */
  async updateEntry(entry: LibraryEntryWithUri): Promise<void> {
    await this.call("/api/library/update", { method: "POST", body: entry });
  }

  /** Remove one album's entry (DELETE /api/library/:uri). URI is path-segment encoded. */
  async removeEntry(uri: string): Promise<void> {
    await this.call(`/api/library/${encodeURIComponent(uri)}`, {
      method: "DELETE",
    });
  }

  /** Replace the whole library in one call (POST /api/library/sync) — the full-reconcile path. */
  async syncAll(entries: LibraryEntryWithUri[]): Promise<void> {
    await this.call("/api/library/sync", { method: "POST", body: { entries } });
  }

  /** Read Backdrop's current library (GET /api/library) — used by verify. */
  async getLibrary(): Promise<BackdropLibrary> {
    return (await this.call("/api/library", {
      method: "GET",
    })) as BackdropLibrary;
  }

  /**
   * Stream a visualizer file to Backdrop (`PUT /api/media/:fileId`, ADR 0038).
   *
   * Separate from `call` because everything about it differs: the body is a file stream rather than
   * JSON, and the bound is a stall timeout rather than the 5s deadline the metadata calls use — 5s
   * would abort every real upload. The file is never read into memory; `Readable.toWeb` hands fetch
   * a stream, which is what `duplex: "half"` is required for.
   */
  async putMedia(
    fileId: string,
    localPath: string,
  ): Promise<{ bytes: number }> {
    const source = createReadStream(localPath);
    const controller = new AbortController();

    // Reset on every chunk: the upload dies only if it stops making progress, not if it is merely
    // slow. Cleared in `finally` so a completed upload never leaves a timer holding the event loop.
    let stallTimer: NodeJS.Timeout | undefined;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () =>
          controller.abort(
            new Error(`upload stalled for ${this.uploadStallMs}ms`),
          ),
        this.uploadStallMs,
      );
    };
    source.on("data", armStallTimer);
    armStallTimer();

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (this.sharedSecret) headers["x-trigger-secret"] = this.sharedSecret;

    try {
      const res = await this.fetchImpl(`${this.url}/api/media/${fileId}`, {
        method: "PUT",
        headers,
        body: Readable.toWeb(source) as ReadableStream,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit & { duplex: "half" });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new BackdropError(
          res.status,
          `Backdrop PUT /api/media/${fileId} → ${res.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      const body = (await res.json().catch(() => ({}))) as { bytes?: number };
      return { bytes: body.bytes ?? 0 };
    } finally {
      clearTimeout(stallTimer);
      source.destroy(); // release the handle whether we finished, threw, or aborted
    }
  }
}
