// Spotify user login via Authorization Code + PKCE (issue #23, ADR 0014). This is the *native-app*
// OAuth flow: no client secret ships in the exchange — a per-login `code_verifier` proves the caller
// is the same client that started the flow. It unlocks user-scoped endpoints (personalized search
// now; Spotify Connect playback later) alongside the existing app-only client-credentials path.
//
// Shape mirrors SpotifyClient deliberately: injectable `fetch`/`now`/`accountsBase` for tests, an
// access-token cache that refreshes ~60s before expiry, and an AbortController timeout so a hung
// accounts.spotify.com can't wedge a request. The refresh token is persisted via ./token-store.
import { randomBytes, createHash } from "node:crypto";
import type { FetchLike } from "./client.js";
import {
  readSpotifyTokens,
  writeSpotifyTokens,
  clearSpotifyTokens,
  type SpotifyTokens,
} from "./token-store.js";

/** Minimum scopes for the follow-on Spotify Connect playback work — requested now so linking the
 *  account for search doesn't force a second consent later (issue #23 §3). `user-read-email` /
 *  `user-read-private` are required by the Web Playback SDK; the rest are transport control. */
export const DEFAULT_SCOPES = [
  "streaming",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-email",
  "user-read-private",
] as const;

/** How long a started-but-not-completed authorize handshake stays valid (guards the pending map). */
const PENDING_TTL_MS = 10 * 60 * 1000;

export class SpotifyAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpotifyAuthError";
  }
}

export interface SpotifyAuthOptions {
  clientId: string;
  /** The exact redirect URI registered on the Spotify app (loopback, e.g. http://127.0.0.1:4739/…). */
  redirectUri: string;
  /** Data dir holding spotify-tokens.json (the persisted refresh token). */
  dataDir: string;
  fetch?: FetchLike;
  accountsBase?: string;
  now?: () => number;
  scopes?: readonly string[];
  timeoutMs?: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

const base64url = (buf: Buffer): string => buf.toString("base64url");
const s256 = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * Manages the PKCE handshake and the resulting user session. One instance per server; connect and
 * disconnect mutate it in place, so status/token calls see the change without a restart (unlike the
 * boot-time credential wiring).
 */
export class SpotifyAuth {
  private readonly fetch: FetchLike;
  private readonly accountsBase: string;
  private readonly now: () => number;
  private readonly scopes: readonly string[];
  private readonly timeoutMs: number;

  // Started authorize flows, keyed by the `state` nonce → the verifier to complete them.
  private readonly pending = new Map<
    string,
    { verifier: string; createdAt: number }
  >();
  // Cached short-lived access token; refreshed before expiry, parallel to SpotifyClient's app token.
  private access?: { value: string; expiresAt: number };
  // The persisted session, lazily loaded from disk (so a session survives a restart).
  private tokens?: SpotifyTokens;
  private tokensLoaded = false;

  constructor(private readonly opts: SpotifyAuthOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.accountsBase = opts.accountsBase ?? "https://accounts.spotify.com";
    this.now = opts.now ?? Date.now;
    this.scopes = opts.scopes ?? DEFAULT_SCOPES;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private loadTokens(): SpotifyTokens | undefined {
    if (!this.tokensLoaded) {
      this.tokens = readSpotifyTokens(this.opts.dataDir);
      this.tokensLoaded = true;
    }
    return this.tokens;
  }

  private setTokens(tokens: SpotifyTokens): void {
    this.tokens = tokens;
    this.tokensLoaded = true;
    writeSpotifyTokens(this.opts.dataDir, tokens);
  }

  /** fetch with an AbortController timeout — a hung accounts.spotify.com rejects, never hangs. */
  private async fetchT(input: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(input, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError")
        throw new SpotifyAuthError(
          `Spotify auth request timed out after ${this.timeoutMs}ms`,
          504,
        );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private form(fields: Record<string, string>): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    };
  }

  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [state, p] of this.pending)
      if (p.createdAt < cutoff) this.pending.delete(state);
  }

  /**
   * Begin a login: generate a PKCE verifier + challenge and a `state` nonce, remember the verifier
   * against `state`, and return the Spotify authorize URL the user's browser should open. Completing
   * the flow requires the matching `state` back at `handleCallback` (CSRF defense).
   */
  buildAuthorizeUrl(): string {
    this.prunePending();
    const verifier = base64url(randomBytes(48)); // 64-char verifier (RFC 7636 allows 43–128)
    const state = base64url(randomBytes(16));
    this.pending.set(state, { verifier, createdAt: this.now() });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: this.scopes.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: s256(verifier),
    });
    return `${this.accountsBase}/authorize?${params.toString()}`;
  }

  /**
   * Complete the login: validate `state`, exchange `code` + the kept verifier for tokens, and
   * persist the refresh token. Throws SpotifyAuthError on an unknown/expired state or a token error.
   */
  async handleCallback(code: string, state: string): Promise<void> {
    this.prunePending();
    const pending = this.pending.get(state);
    if (!pending)
      throw new SpotifyAuthError("unknown or expired login state", 400);
    this.pending.delete(state);

    const res = await this.fetchT(
      `${this.accountsBase}/api/token`,
      this.form({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.opts.redirectUri,
        client_id: this.opts.clientId,
        code_verifier: pending.verifier,
      }),
    );
    if (!res.ok)
      throw new SpotifyAuthError(
        `Spotify token exchange failed (${res.status})`,
        res.status,
      );
    const body = (await res.json()) as TokenResponse;
    if (!body.refresh_token)
      throw new SpotifyAuthError("Spotify did not return a refresh token", 502);

    this.setTokens({
      refreshToken: body.refresh_token,
      scope: body.scope ?? this.scopes.join(" "),
      obtainedAt: new Date(this.now()).toISOString(),
    });
    this.access = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in - 60) * 1000,
    };
  }

  /**
   * A valid user access token, or `undefined` when no user is connected. Refreshes (and caches) as
   * needed. If the refresh token has been revoked (Spotify `invalid_grant`), the stored session is
   * cleared and a SpotifyAuthError is thrown so the UI can prompt a reconnect.
   */
  async userAccessToken(): Promise<string | undefined> {
    const tokens = this.loadTokens();
    if (!tokens) return undefined;
    if (this.access && this.access.expiresAt > this.now())
      return this.access.value;

    const res = await this.fetchT(
      `${this.accountsBase}/api/token`,
      this.form({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: this.opts.clientId,
      }),
    );
    if (res.status === 400) {
      // A revoked/expired refresh token — the session is dead. Clear it so status reflects reality.
      this.disconnect();
      throw new SpotifyAuthError("Spotify session expired — reconnect", 401);
    }
    if (!res.ok)
      throw new SpotifyAuthError(
        `Spotify token refresh failed (${res.status})`,
        res.status,
      );
    const body = (await res.json()) as TokenResponse;
    // Spotify may rotate the refresh token; persist the new one when it does.
    if (body.refresh_token && body.refresh_token !== tokens.refreshToken)
      this.setTokens({
        ...tokens,
        refreshToken: body.refresh_token,
        scope: body.scope ?? tokens.scope,
      });
    this.access = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in - 60) * 1000,
    };
    return this.access.value;
  }

  /** Whether a user session exists, plus the granted scopes — backs GET /api/spotify/auth/status. */
  status(): { connected: boolean; scope?: string } {
    const tokens = this.loadTokens();
    return tokens
      ? { connected: true, scope: tokens.scope }
      : { connected: false };
  }

  /** Drop the user session (Disconnect): forget the refresh token and the cached access token. */
  disconnect(): void {
    clearSpotifyTokens(this.opts.dataDir);
    this.tokens = undefined;
    this.tokensLoaded = true;
    this.access = undefined;
  }
}
