import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { writeSpotifyTokens } from "../src/spotify/token-store.js";
import { fakeRoadie } from "./helpers.js";

// These drive the *server's own* wiring: the SpotifyAuth + SpotifyClient it builds from config. We
// stub the global fetch with the fake so both use it (there's no per-client fetch injection through
// buildServer), then exercise the routes over HTTP — proving search runs through the user session
// when connected and falls back to the app token when it isn't.

const REDIRECT = "http://127.0.0.1:4739/api/spotify/auth/callback";
const album: FakeAlbum = {
  id: "1C2h7mLntPSeVYciMRTF4a",
  name: "Purple Rain",
  artist: { id: "prince1", name: "Prince" },
  year: 1984,
  genres: ["funk"],
  artwork: Buffer.from("IMG"),
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let fs: ReturnType<typeof createFakeSpotify>;
beforeEach(() => {
  fs = createFakeSpotify([album]);
  globalThis.fetch = fs.fetch as typeof globalThis.fetch;
});

function serverAt(dataDir = mkdtempSync(join(tmpdir(), "curator-authr-"))) {
  const store = new AssetStore(dataDir);
  const { app } = buildServer({
    store,
    roadie: fakeRoadie(store),
    config: {
      dataDir,
      spotify: { clientId: "cid", clientSecret: "csec", redirectUri: REDIRECT },
    },
  });
  return { app, dataDir };
}

// Walk the browser step: read the challenge/state off the authorize URL, mint a code, hit callback.
async function login(app: ReturnType<typeof serverAt>["app"]) {
  const login = await app.inject({ url: "/api/spotify/auth/login" });
  const url = new URL(login.json().authorizeUrl);
  const state = url.searchParams.get("state")!;
  const code = fs.issueAuthCode({
    codeChallenge: url.searchParams.get("code_challenge")!,
    redirectUri: REDIRECT,
    scope: "streaming",
  });
  return app.inject({
    url: `/api/spotify/auth/callback?code=${code}&state=${state}`,
  });
}

describe("Spotify user-auth routes", () => {
  it("logs in via the callback, reports connected, and disconnects", async () => {
    const { app } = serverAt();
    expect(
      (await app.inject({ url: "/api/spotify/auth/status" })).json(),
    ).toEqual({ connected: false });

    const cb = await login(app);
    expect(cb.statusCode).toBe(200);
    expect(cb.headers["content-type"]).toContain("text/html");
    expect(cb.body).toContain("Connected");

    expect(
      (await app.inject({ url: "/api/spotify/auth/status" })).json().connected,
    ).toBe(true);

    const off = await app.inject({
      method: "POST",
      url: "/api/spotify/auth/disconnect",
    });
    expect(off.json()).toEqual({ ok: true });
    expect(
      (await app.inject({ url: "/api/spotify/auth/status" })).json().connected,
    ).toBe(false);
  });

  it("routes search through the user token once connected (no app-token request)", async () => {
    const { app } = serverAt();
    await login(app);
    const res = await app.inject({
      url: "/api/spotify/search-albums?q=purple",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].name).toBe("Purple Rain");
    // Connected: the user token carried the search — the app (client-credentials) token was never
    // requested.
    expect(fs.appTokenRequests()).toBe(0);
  });

  it("falls back to the app token for search when no user is connected", async () => {
    const { app } = serverAt();
    const res = await app.inject({
      url: "/api/spotify/search-albums?q=purple",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].name).toBe("Purple Rain");
    expect(fs.appTokenRequests()).toBe(1);
  });

  it("degrades to the app token (and clears) when the stored session is revoked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "curator-authr-"));
    // Seed a refresh token the fake never issued → its refresh endpoint 400s (revoked).
    writeSpotifyTokens(dataDir, {
      refreshToken: "revoked",
      scope: "streaming",
      obtainedAt: new Date(0).toISOString(),
    });
    const { app } = serverAt(dataDir);

    // Search still succeeds: the broken user session degrades to the app token rather than 5xx-ing.
    const res = await app.inject({
      url: "/api/spotify/search-albums?q=purple",
    });
    expect(res.statusCode).toBe(200);
    expect(fs.appTokenRequests()).toBe(1);
    // The revoked token was cleared, so status now shows disconnected (UI can prompt a reconnect).
    expect(
      (await app.inject({ url: "/api/spotify/auth/status" })).json().connected,
    ).toBe(false);
  });

  it("rejects a callback with an unknown state", async () => {
    const { app } = serverAt();
    await app.inject({ url: "/api/spotify/auth/login" }); // start a flow (different state)
    const res = await app.inject({
      url: "/api/spotify/auth/callback?code=x&state=bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Login failed");
  });
});
