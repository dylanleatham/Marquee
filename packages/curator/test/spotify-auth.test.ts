import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify } from "@marquee/fake-spotify";
import { SpotifyAuth, DEFAULT_SCOPES } from "../src/spotify/auth.js";
import type { FetchLike } from "../src/spotify/client.js";
import {
  writeSpotifyTokens,
  readSpotifyTokens,
} from "../src/spotify/token-store.js";

const REDIRECT = "http://127.0.0.1:4739/api/spotify/auth/callback";
const dir = () => mkdtempSync(join(tmpdir(), "curator-auth-"));

const build = (opts: { now?: () => number; dataDir?: string } = {}) => {
  const fs = createFakeSpotify();
  const dataDir = opts.dataDir ?? dir();
  const auth = new SpotifyAuth({
    clientId: "cid",
    redirectUri: REDIRECT,
    dataDir,
    fetch: fs.fetch,
    now: opts.now,
  });
  return { fs, auth, dataDir };
};

// Drive the browser authorize step the fake models: read the challenge/state the client generated,
// mint a matching code, and complete the callback — exercising real PKCE end to end.
const connect = async (
  auth: SpotifyAuth,
  fs: ReturnType<typeof createFakeSpotify>,
) => {
  const url = new URL(auth.buildAuthorizeUrl());
  const state = url.searchParams.get("state")!;
  const codeChallenge = url.searchParams.get("code_challenge")!;
  const code = fs.issueAuthCode({
    codeChallenge,
    redirectUri: REDIRECT,
    scope: DEFAULT_SCOPES.join(" "),
  });
  await auth.handleCallback(code, state);
  return state;
};

describe("SpotifyAuth (Authorization Code + PKCE)", () => {
  it("builds an authorize URL with PKCE (S256), state, and the playback scopes", () => {
    const { auth } = build();
    const url = new URL(auth.buildAuthorizeUrl());
    expect(url.host).toBe("accounts.spotify.com");
    expect(url.pathname).toBe("/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("state")).toBeTruthy();
    // Playback scopes are requested up front so linking for search doesn't force a re-consent later.
    const scope = p.get("scope") ?? "";
    expect(scope).toContain("user-modify-playback-state");
    expect(scope).toContain("streaming");
  });

  it("is disconnected before login", async () => {
    const { auth } = build();
    expect(auth.status()).toEqual({ connected: false });
    expect(await auth.userAccessToken()).toBeUndefined();
  });

  it("completes the callback, persists the refresh token, and reports connected", async () => {
    const { auth, fs, dataDir } = build();
    await connect(auth, fs);
    expect(auth.status().connected).toBe(true);
    // The refresh token is persisted so the session survives a restart.
    const reloaded = new SpotifyAuth({
      clientId: "cid",
      redirectUri: REDIRECT,
      dataDir,
      fetch: fs.fetch,
    });
    expect(reloaded.status().connected).toBe(true);
    expect(await reloaded.userAccessToken()).toBeTruthy();
  });

  it("rejects a callback whose state was never issued (CSRF guard)", async () => {
    const { auth } = build();
    auth.buildAuthorizeUrl();
    await expect(
      auth.handleCallback("some-code", "bogus-state"),
    ).rejects.toMatchObject({ name: "SpotifyAuthError", status: 400 });
  });

  it("caches the access token and refreshes only after expiry", async () => {
    let clock = 0;
    const { auth, fs } = build({ now: () => clock });
    await connect(auth, fs); // access token cached from the code exchange
    expect(fs.refreshRequests()).toBe(0);

    await auth.userAccessToken(); // still fresh — no refresh
    expect(fs.refreshRequests()).toBe(0);

    clock = 3_600_000; // past the ~1h expiry
    await auth.userAccessToken();
    expect(fs.refreshRequests()).toBe(1);
    await auth.userAccessToken(); // fresh again — cached
    expect(fs.refreshRequests()).toBe(1);
  });

  it("dedups concurrent refreshes onto a single exchange", async () => {
    let clock = 0;
    const { auth, fs } = build({ now: () => clock });
    await connect(auth, fs);
    clock = 3_600_000; // expire the cached token
    // Two callers hit an expired token at once — they must share one refresh, not race two (a race
    // could 400 the loser and falsely disconnect if Spotify rotated the token between them).
    const [a, b] = await Promise.all([
      auth.userAccessToken(),
      auth.userAccessToken(),
    ]);
    expect(a).toBe(b);
    expect(fs.refreshRequests()).toBe(1);
  });

  it("persists a rotated refresh token from the refresh response", async () => {
    const dataDir = dir();
    writeSpotifyTokens(dataDir, {
      refreshToken: "old",
      scope: "streaming",
      obtainedAt: new Date(0).toISOString(),
    });
    // A stub that rotates the refresh token, as Spotify sometimes does — the new one must be stored.
    const fetchStub: FetchLike = async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old");
      return new Response(
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rotated",
          scope: "streaming",
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const auth = new SpotifyAuth({
      clientId: "cid",
      redirectUri: REDIRECT,
      dataDir,
      fetch: fetchStub,
    });
    expect(await auth.userAccessToken()).toBe("at");
    expect(readSpotifyTokens(dataDir)?.refreshToken).toBe("rotated");
  });

  it("disconnect forgets the session", async () => {
    const { auth, fs } = build();
    await connect(auth, fs);
    expect(auth.status().connected).toBe(true);
    auth.disconnect();
    expect(auth.status()).toEqual({ connected: false });
    expect(await auth.userAccessToken()).toBeUndefined();
  });

  it("clears a revoked refresh token and surfaces an error", async () => {
    const { auth, fs, dataDir } = build();
    // A refresh token the fake never issued → the refresh endpoint 400s (revoked/expired).
    writeSpotifyTokens(dataDir, {
      refreshToken: "revoked",
      scope: "streaming",
      obtainedAt: new Date(0).toISOString(),
    });
    void fs;
    await expect(auth.userAccessToken()).rejects.toMatchObject({
      name: "SpotifyAuthError",
    });
    // Cleared, so the UI can prompt a reconnect rather than showing a stuck "connected".
    expect(auth.status()).toEqual({ connected: false });
  });
});
