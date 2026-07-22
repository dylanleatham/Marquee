import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber } from "./helpers.js";
import { DiscogsOAuth } from "../src/discogs/oauth.js";
import type { FetchLike } from "../src/discogs/client.js";

// Issue #59: the "log in with Discogs" routes. The handshake itself is unit-tested on DiscogsOAuth;
// here we cover the route wiring, the callback HTML, and the not-configured (503) path.
const fakeServer = (): FetchLike => async (input) => {
  const url = String(input);
  if (url.endsWith("/oauth/request_token"))
    return new Response("oauth_token=REQ&oauth_token_secret=REQSEC");
  if (url.endsWith("/oauth/access_token"))
    return new Response("oauth_token=ACC&oauth_token_secret=ACCSEC");
  if (url.endsWith("/oauth/identity"))
    return new Response(JSON.stringify({ username: "dj" }), {
      headers: { "content-type": "application/json" },
    });
  return new Response("nf", { status: 404 });
};

describe("Discogs OAuth routes", () => {
  let store: AssetStore;
  const build = (withAuth = true) => {
    const dir = mkdtempSync(join(tmpdir(), "curator-dauth-"));
    store = new AssetStore(dir);
    const discogsAuth = withAuth
      ? new DiscogsOAuth({
          consumerKey: "ck",
          consumerSecret: "cs",
          callbackUrl: "http://127.0.0.1:4739/api/discogs/auth/callback",
          dataDir: dir,
          fetch: fakeServer(),
          nonce: () => "n",
        })
      : undefined;
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      ...(discogsAuth ? { discogsAuth } : {}),
    });
    return app;
  };

  beforeEach(() => {});

  it("logs in, completes the callback, reports connected, and disconnects", async () => {
    const app = build();

    const login = await app.inject({ url: "/api/discogs/auth/login" });
    expect(login.statusCode).toBe(200);
    expect(login.json().authorizeUrl).toBe(
      "https://www.discogs.com/oauth/authorize?oauth_token=REQ",
    );

    const cb = await app.inject({
      url: "/api/discogs/auth/callback?oauth_token=REQ&oauth_verifier=V",
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers["content-type"]).toContain("text/html");
    expect(cb.body).toContain("Discogs connected");

    const status = await app.inject({ url: "/api/discogs/auth/status" });
    expect(status.json()).toMatchObject({ connected: true, username: "dj" });

    const off = await app.inject({
      method: "POST",
      url: "/api/discogs/auth/disconnect",
    });
    expect(off.json()).toEqual({ ok: true });
    const after = await app.inject({ url: "/api/discogs/auth/status" });
    expect(after.json()).toEqual({ connected: false });
  });

  it("shows a cancelled message when the user denies", async () => {
    const app = build();
    const cb = await app.inject({
      url: "/api/discogs/auth/callback?denied=1",
    });
    expect(cb.body).toContain("cancelled");
  });

  it("503s login and status reports disconnected when OAuth isn't configured", async () => {
    const app = build(false);
    expect(
      (await app.inject({ url: "/api/discogs/auth/login" })).statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ url: "/api/discogs/auth/status" })).json(),
    ).toEqual({ connected: false });
  });
});
