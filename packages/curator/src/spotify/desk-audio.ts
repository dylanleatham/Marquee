// Desk audio for bench preview (ADR 0037, issue #93): play a track from the album on the
// producer's OWN workstation while they judge a sleeve, by transferring Spotify Connect to the
// desktop Spotify client.
//
// Two properties this module exists to hold, both from the ADR:
//
//  1. **Only a local `Computer` device is ever a legal target.** Bench preview's promise is that it
//     touches no hardware, ever (curator-ui-ux §6.1) — and Connect works by aiming at a device id,
//     so aiming at the Sonos would silently break that promise. The filter lives here, server-side,
//     and the browser never gets to name a device.
//  2. **Degradation is reported, never fatal** (§10). No client running, not Premium, no Spotify URI,
//     Spotify unreachable — each comes back as a `reason` the UI shows next to the control, and the
//     rest of bench preview keeps working. Nothing here throws for an expected condition.
//
// Shape mirrors SpotifyClient: injectable `fetch`/`apiBase` for tests, and an AbortController
// timeout on every call so a hung api.spotify.com can't wedge an always-on Curator.
import type { FetchLike } from "./client.js";

/** A Connect device as the Web API reports it. Only the fields the desk filter needs. */
interface ConnectDevice {
  id: string;
  name: string;
  type: string;
  is_restricted?: boolean;
}

export interface DeskAudioOptions {
  /** A connected user's access token, or undefined when no Spotify session exists. */
  getUserToken: () => Promise<string | undefined>;
  fetch?: FetchLike;
  apiBase?: string;
  /** Per-request timeout (ms). A hung Spotify connection must fail fast, not hang the request. */
  timeoutMs?: number;
}

export interface PlayResult {
  played: boolean;
  /** The device audio is coming out of, so the UI can name it rather than say "somewhere". */
  device?: string;
  reason?: string;
}

export interface PauseResult {
  paused: boolean;
  reason?: string;
}

/** Every reason the UI can show, in one place — these are user-facing sentences, not error codes. */
const NOT_CONNECTED =
  "Spotify isn't connected — connect it in Settings to hear desk audio";
const NO_DESK_CLIENT =
  "No desktop Spotify client running on this machine — open Spotify and try again";
const NEEDS_PREMIUM =
  "Spotify Premium is required to control playback from another app";
const SESSION_EXPIRED = "Spotify session expired — reconnect it in Settings";
const RATE_LIMITED =
  "Spotify is rate-limiting this app — try again in a moment";

/**
 * Turn a non-2xx into the sentence a producer can act on. Anything unrecognised keeps the status
 * and Spotify's own message rather than collapsing into "something went wrong".
 */
function reasonFor(status: number, message: string): string {
  if (status === 401) return SESSION_EXPIRED;
  if (status === 403) return NEEDS_PREMIUM;
  if (status === 404) return NO_DESK_CLIENT;
  if (status === 429) return RATE_LIMITED;
  return `Spotify returned ${status}${message ? ` — ${message}` : ""}`;
}

export class DeskAudio {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DeskAudioOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? "https://api.spotify.com";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * One Web API call. Returns the status and parsed body instead of throwing, because at this layer
   * a 403 is a sentence to show the producer, not an exception to unwind.
   *
   * Player endpoints answer 204, an empty body, or (for pause) an opaque non-JSON string, so the
   * body is parsed defensively — a successful call must not fail on its own response.
   */
  private async call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = { raw: text };
      }
      return { status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Spotify's own error message for a failed call, when it sent one. */
  private static message(body: Record<string, unknown>): string {
    const error = body.error as { message?: string } | string | undefined;
    if (typeof error === "string") return error;
    return error?.message ?? "";
  }

  /**
   * The device bench preview is allowed to play on: a `Computer` this account can control. A
   * restricted device is listed but refuses Web API commands, so it is not a target either.
   * Speakers — the Sonos included — are never candidates. See property 1 in the file header.
   */
  private static deskDevice(
    devices: ConnectDevice[],
  ): ConnectDevice | undefined {
    return devices.find((d) => d.type === "Computer" && !d.is_restricted);
  }

  /** Start `spotifyUri` at the desk. Never throws: every failure comes back as a reason. */
  async play(spotifyUri: string): Promise<PlayResult> {
    const token = await this.opts.getUserToken();
    if (!token) return { played: false, reason: NOT_CONNECTED };

    try {
      const list = await this.call(token, "GET", "/v1/me/player/devices");
      if (list.status >= 400)
        return {
          played: false,
          reason: reasonFor(list.status, DeskAudio.message(list.body)),
        };

      const desk = DeskAudio.deskDevice(
        (list.body.devices as ConnectDevice[] | undefined) ?? [],
      );
      if (!desk) return { played: false, reason: NO_DESK_CLIENT };

      // Targeting by id both transfers playback to the desk and starts the album on it.
      const res = await this.call(
        token,
        "PUT",
        `/v1/me/player/play?device_id=${encodeURIComponent(desk.id)}`,
        { context_uri: spotifyUri, offset: { position: 0 }, position_ms: 0 },
      );
      if (res.status >= 400)
        return {
          played: false,
          reason: reasonFor(res.status, DeskAudio.message(res.body)),
        };
      return { played: true, device: desk.name };
    } catch (err) {
      return { played: false, reason: this.unreachable(err) };
    }
  }

  /** Pause the desk. Already-paused counts as success — the producer asked for silence, not a call. */
  async pause(): Promise<PauseResult> {
    const token = await this.opts.getUserToken();
    if (!token) return { paused: false, reason: NOT_CONNECTED };

    try {
      const res = await this.call(token, "PUT", "/v1/me/player/pause");
      // 403 "Restriction violated" is Spotify's answer to pausing an already-paused player, and 404
      // is its answer to there being no active device at all. Both are the state we wanted.
      if (res.status === 404) return { paused: true };
      if (
        res.status === 403 &&
        /restriction violated/i.test(DeskAudio.message(res.body))
      )
        return { paused: true };
      if (res.status >= 400)
        return {
          paused: false,
          reason: reasonFor(res.status, DeskAudio.message(res.body)),
        };
      return { paused: true };
    } catch (err) {
      return { paused: false, reason: this.unreachable(err) };
    }
  }

  /** A transport failure, said in a way a producer can act on — timeout named as a timeout. */
  private unreachable(err: unknown): string {
    if ((err as Error)?.name === "AbortError")
      return `Spotify did not respond within ${this.timeoutMs}ms`;
    return `Spotify is unreachable — ${(err as Error).message}`;
  }
}
