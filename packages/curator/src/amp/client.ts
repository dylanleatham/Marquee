// Outbound HTTP to Amp's admin API (amp-spec §Admin). Amp is the audio leg of the room rehearsal
// (ADR 0028): a rehearsal drives lights via Conductor, video via Backdrop, and audio via Amp. Mirrors
// BackdropClient exactly — `fetch` with an AbortSignal timeout so a wedged Amp can't hang the caller
// (Curator is always-on; an unbounded call would wedge the event loop), `fetchImpl` injectable for tests.

type FetchImpl = typeof fetch;

export interface AmpClientOptions {
  /** Base URL of the Amp service, e.g. http://runtime-pi:4741. */
  url: string;
  /** The shared secret sent as X-Trigger-Secret; omit only if Amp runs with auth disabled. */
  sharedSecret?: string;
  /** Per-request timeout (ms). Default 5s, matching the Backdrop client and Conductor proxy. */
  timeoutMs?: number;
  /** Injected fetch (tests). Defaults to the global. */
  fetchImpl?: FetchImpl;
}

/** Amp returned a non-2xx status. */
export class AmpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AmpError";
  }
}

/** Amp's reported state (GET /api/status, amp-spec §Admin). */
export interface AmpStatus {
  state?: string;
  album?: string;
  target?: string;
  derived?: boolean;
}

export class AmpClient {
  private readonly url: string;
  private readonly sharedSecret?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: AmpClientOptions) {
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
    // Only declare a JSON content-type when a body is actually sent — a bodyless request with
    // `content-type: application/json` trips Fastify's FST_ERR_CTP_EMPTY_JSON_BODY (400).
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
      throw new AmpError(
        res.status,
        `Amp ${init.method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res.json().catch(() => ({}));
  }

  /**
   * Start playback of an album over Sonos (POST /api/admin/play). Amp specs this as the manual
   * override for dev and smoke tests — which is precisely what a rehearsal is (ADR 0028).
   */
  async play(spotifyUri: string, targetRoom?: string): Promise<void> {
    await this.call("/api/admin/play", {
      method: "POST",
      body: {
        spotifyUri,
        ...(targetRoom ? { targetRoom } : {}),
      },
    });
  }

  /** Force Amp back to idle (POST /api/admin/stop) — the "lift sleeve" half of a rehearsal. */
  async stop(): Promise<void> {
    await this.call("/api/admin/stop", { method: "POST" });
  }

  /** Amp's current state (GET /api/status). Used for the rehearsal's audio-reachability badge. */
  async status(): Promise<AmpStatus> {
    return (await this.call("/api/status", { method: "GET" })) as AmpStatus;
  }
}
