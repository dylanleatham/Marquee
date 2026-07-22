import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscogsOAuth, DiscogsOAuthError } from "../src/discogs/oauth.js";
import type { FetchLike } from "../src/discogs/client.js";

const dataDir = () => mkdtempSync(join(tmpdir(), "curator-dsc-oauth-"));

/** A fake Discogs OAuth server: request_token → access_token → identity, recording the auth headers. */
function fakeDiscogsServer() {
  const seen: Array<{ url: string; auth: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({
      url,
      auth: String((init?.headers as Record<string, string>)?.Authorization),
    });
    if (url.endsWith("/oauth/request_token"))
      return new Response(
        "oauth_token=REQ&oauth_token_secret=REQSEC&oauth_callback_confirmed=true",
      );
    if (url.endsWith("/oauth/access_token"))
      return new Response("oauth_token=ACC&oauth_token_secret=ACCSEC");
    if (url.endsWith("/oauth/identity"))
      return new Response(JSON.stringify({ username: "crate_digger" }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("not found", { status: 404 });
  };
  return { fetch, seen };
}

const make = (dir: string, fetch: FetchLike, over = {}) =>
  new DiscogsOAuth({
    consumerKey: "ck",
    consumerSecret: "cs",
    callbackUrl: "http://127.0.0.1:4739/api/discogs/auth/callback",
    dataDir: dir,
    fetch,
    now: () => 1_700_000_000_000,
    nonce: () => "nonce",
    ...over,
  });

describe("DiscogsOAuth (issue #59)", () => {
  let dir: string;
  beforeEach(() => {
    dir = dataDir();
  });

  it("fetches a request token and returns the authorize URL", async () => {
    const { fetch, seen } = fakeDiscogsServer();
    const auth = make(dir, fetch);
    const url = await auth.buildAuthorizeUrl();
    expect(url).toBe("https://www.discogs.com/oauth/authorize?oauth_token=REQ");
    // The request-token call was PLAINTEXT-signed with the consumer secret + callback.
    expect(seen[0]!.url).toMatch(/\/oauth\/request_token$/);
    expect(seen[0]!.auth).toContain('oauth_signature_method="PLAINTEXT"');
    expect(seen[0]!.auth).toContain("oauth_callback");
  });

  it("completes the handshake, persists the session, and resolves the username", async () => {
    const { fetch } = fakeDiscogsServer();
    const auth = make(dir, fetch);
    await auth.buildAuthorizeUrl();
    await auth.handleCallback("REQ", "VERIFIER");

    expect(auth.status()).toEqual({
      connected: true,
      username: "crate_digger",
    });
    // A fresh instance loads the persisted session from disk (survives a restart).
    const reloaded = make(dir, fetch);
    expect(reloaded.status().connected).toBe(true);
  });

  it("signs API requests with the access token once connected", async () => {
    const { fetch } = fakeDiscogsServer();
    const auth = make(dir, fetch);
    await auth.buildAuthorizeUrl();
    await auth.handleCallback("REQ", "VERIFIER");

    const header = auth.apiAuthHeader()!;
    expect(header).toContain('oauth_token="ACC"');
    expect(header).toContain('oauth_signature="cs%26ACCSEC"'); // enc("cs&ACCSEC")
  });

  it("has no api header before connecting", () => {
    const { fetch } = fakeDiscogsServer();
    expect(make(dir, fetch).apiAuthHeader()).toBeUndefined();
  });

  it("rejects a callback for an unknown/expired request token", async () => {
    const { fetch } = fakeDiscogsServer();
    const auth = make(dir, fetch);
    await expect(auth.handleCallback("NOPE", "v")).rejects.toBeInstanceOf(
      DiscogsOAuthError,
    );
  });

  it("disconnect forgets the session", async () => {
    const { fetch } = fakeDiscogsServer();
    const auth = make(dir, fetch);
    await auth.buildAuthorizeUrl();
    await auth.handleCallback("REQ", "VERIFIER");
    auth.disconnect();
    expect(auth.status().connected).toBe(false);
    expect(auth.apiAuthHeader()).toBeUndefined();
  });

  it("throws when the request-token call fails", async () => {
    const failing: FetchLike = async () =>
      new Response("nope", { status: 401 });
    await expect(make(dir, failing).buildAuthorizeUrl()).rejects.toMatchObject({
      name: "DiscogsOAuthError",
      status: 401,
    });
  });
});
