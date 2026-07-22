// Discogs OAuth 1.0a — the 3-legged "log in with Discogs" flow (issue #59 / ADR 0017). This is the
// deferred alternative to the personal-access-token path (ADR 0016): request token → authorize
// redirect → access token, PLAINTEXT-signed over HTTPS (see ./oauth-sign). Shape mirrors SpotifyAuth
// deliberately — injectable fetch/now/nonce for tests, a pending map guarding started handshakes, and
// the session persisted via ./oauth-token-store so it survives a restart.
import { randomBytes } from "node:crypto";
import type { FetchLike } from "./client.js";
import { oauthHeader, parseTokenResponse } from "./oauth-sign.js";
import {
  readDiscogsTokens,
  writeDiscogsTokens,
  clearDiscogsTokens,
  type DiscogsOAuthTokens,
} from "./oauth-token-store.js";

/** How long a started-but-not-completed handshake stays valid (guards the pending map). */
const PENDING_TTL_MS = 10 * 60 * 1000;

export class DiscogsOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscogsOAuthError";
  }
}

export interface DiscogsOAuthOptions {
  /** The Discogs application's consumer key + secret (register an app to get these). */
  consumerKey: string;
  consumerSecret: string;
  /** The callback URL registered on the Discogs app (loopback, e.g. http://127.0.0.1:4739/…). */
  callbackUrl: string;
  /** Data dir holding discogs-tokens.json (the persisted access token + secret). */
  dataDir: string;
  fetch?: FetchLike;
  /** api.discogs.com base — overridable for tests. */
  apiBase?: string;
  /** www.discogs.com base for the authorize redirect — overridable for tests. */
  authorizeBase?: string;
  now?: () => number;
  /** Nonce generator (injected for deterministic tests). */
  nonce?: () => string;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * Owns the OAuth 1.0a handshake + the resulting session. One instance per server; connect and
 * disconnect mutate it in place so status/header calls see the change without a restart.
 */
export class DiscogsOAuth {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly authorizeBase: string;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  // Request tokens awaiting their verifier: oauth_token → { secret, createdAt }.
  private readonly pending = new Map<
    string,
    { secret: string; createdAt: number }
  >();
  private tokens?: DiscogsOAuthTokens;
  private tokensLoaded = false;

  constructor(private readonly opts: DiscogsOAuthOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? "https://api.discogs.com";
    this.authorizeBase = opts.authorizeBase ?? "https://www.discogs.com";
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? (() => randomBytes(16).toString("hex"));
    this.userAgent =
      opts.userAgent ?? "Marquee/1.0 +https://github.com/marquee";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private loadTokens(): DiscogsOAuthTokens | undefined {
    if (!this.tokensLoaded) {
      this.tokens = readDiscogsTokens(this.opts.dataDir);
      this.tokensLoaded = true;
    }
    return this.tokens;
  }

  private setTokens(tokens: DiscogsOAuthTokens): void {
    this.tokens = tokens;
    this.tokensLoaded = true;
    writeDiscogsTokens(this.opts.dataDir, tokens);
  }

  private stamp(): { nonce: string; timestamp: string } {
    return {
      nonce: this.nonce(),
      timestamp: Math.floor(this.now() / 1000).toString(),
    };
  }

  /** fetch with an AbortController timeout — a hung Discogs endpoint rejects, never hangs. */
  private async fetchT(input: string, header: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(input, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: header, "User-Agent": this.userAgent },
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError")
        throw new DiscogsOAuthError(
          `Discogs auth request timed out after ${this.timeoutMs}ms`,
          504,
        );
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [token, p] of this.pending)
      if (p.createdAt < cutoff) this.pending.delete(token);
  }

  /**
   * Leg 1+2: fetch a request token (signed with the consumer secret + the callback), remember its
   * secret, and return the authorize URL the user's browser should open. Completing the flow requires
   * the matching `oauth_token` back at `handleCallback`.
   */
  async buildAuthorizeUrl(): Promise<string> {
    this.prunePending();
    const { nonce, timestamp } = this.stamp();
    const header = oauthHeader({
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
      callback: this.opts.callbackUrl,
      nonce,
      timestamp,
    });
    const res = await this.fetchT(
      `${this.apiBase}/oauth/request_token`,
      header,
    );
    if (!res.ok)
      throw new DiscogsOAuthError(
        `Discogs request-token failed (${res.status})`,
        res.status,
      );
    const parsed = parseTokenResponse(await res.text());
    const token = parsed.oauth_token;
    const secret = parsed.oauth_token_secret;
    if (!token || !secret)
      throw new DiscogsOAuthError("Discogs returned no request token", 502);
    this.pending.set(token, { secret, createdAt: this.now() });
    return `${this.authorizeBase}/oauth/authorize?oauth_token=${encodeURIComponent(
      token,
    )}`;
  }

  /**
   * Leg 3: exchange the request token + verifier for an access token, then resolve the username and
   * persist the session. Throws DiscogsOAuthError on an unknown/expired token or an exchange error.
   */
  async handleCallback(oauthToken: string, verifier: string): Promise<void> {
    this.prunePending();
    const pending = this.pending.get(oauthToken);
    if (!pending)
      throw new DiscogsOAuthError("unknown or expired request token", 400);
    this.pending.delete(oauthToken);

    const { nonce, timestamp } = this.stamp();
    const header = oauthHeader({
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
      token: oauthToken,
      tokenSecret: pending.secret,
      verifier,
      nonce,
      timestamp,
    });
    const res = await this.fetchT(`${this.apiBase}/oauth/access_token`, header);
    if (!res.ok)
      throw new DiscogsOAuthError(
        `Discogs access-token exchange failed (${res.status})`,
        res.status,
      );
    const parsed = parseTokenResponse(await res.text());
    const accessToken = parsed.oauth_token;
    const accessTokenSecret = parsed.oauth_token_secret;
    if (!accessToken || !accessTokenSecret)
      throw new DiscogsOAuthError("Discogs returned no access token", 502);

    const username = await this.resolveUsername(accessToken, accessTokenSecret);
    this.setTokens({
      accessToken,
      accessTokenSecret,
      ...(username ? { username } : {}),
      obtainedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Best-effort: fetch the identity so the UI can show whose account is connected. A failure here
   *  doesn't fail the connect — the session is still valid, just unlabeled. */
  private async resolveUsername(
    accessToken: string,
    accessTokenSecret: string,
  ): Promise<string | undefined> {
    try {
      const { nonce, timestamp } = this.stamp();
      const header = oauthHeader({
        consumerKey: this.opts.consumerKey,
        consumerSecret: this.opts.consumerSecret,
        token: accessToken,
        tokenSecret: accessTokenSecret,
        nonce,
        timestamp,
      });
      // The identity endpoint is a GET, but the header carries the auth; reuse fetchT with POST-less
      // semantics by issuing the request directly.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(`${this.apiBase}/oauth/identity`, {
          method: "GET",
          signal: ctrl.signal,
          headers: { Authorization: header, "User-Agent": this.userAgent },
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { username?: string };
        return typeof body.username === "string" ? body.username : undefined;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    }
  }

  /**
   * A signed `Authorization: OAuth …` header for a Discogs API request, or `undefined` when no user
   * is connected. The DiscogsClient uses this so the collection/add paths sign transparently.
   */
  apiAuthHeader(): string | undefined {
    const tokens = this.loadTokens();
    if (!tokens) return undefined;
    const { nonce, timestamp } = this.stamp();
    return oauthHeader({
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
      token: tokens.accessToken,
      tokenSecret: tokens.accessTokenSecret,
      nonce,
      timestamp,
    });
  }

  /** Whether a user session exists + the connected username — backs GET /api/discogs/auth/status. */
  status(): { connected: boolean; username?: string } {
    const tokens = this.loadTokens();
    return tokens
      ? {
          connected: true,
          ...(tokens.username ? { username: tokens.username } : {}),
        }
      : { connected: false };
  }

  /** Drop the session (Disconnect): forget the access token. Takes effect immediately. */
  disconnect(): void {
    clearDiscogsTokens(this.opts.dataDir);
    this.tokens = undefined;
    this.tokensLoaded = true;
  }
}
