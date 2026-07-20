import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSpotify, type FakeAlbum } from "../src/index.js";

const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const exchange = (
  fs: ReturnType<typeof createFakeSpotify>,
  body: Record<string, string>,
) =>
  fs.fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

const album: FakeAlbum = {
  id: "1C2h7mLntPSeVYciMRTF4a",
  name: "Purple Rain",
  artist: { id: "5a2EaR3hamoenG9rDuVn8j", name: "Prince" },
  year: 1984,
  genres: ["funk", "pop"],
  artwork: Buffer.from("JPEGDATA"),
};

const withToken = { headers: { Authorization: "Bearer fake-token" } };

describe("fake-spotify", () => {
  it("issues a token for Basic auth and rejects without it", async () => {
    const fs = createFakeSpotify();
    const bad = await fs.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
    });
    expect(bad.status).toBe(401);
    const ok = await fs.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: "Basic abc" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toBe("fake-token");
    expect(fs.tokenRequests()).toBe(2);
  });

  it("requires a bearer token on the Web API", async () => {
    const fs = createFakeSpotify([album]);
    const res = await fs.fetch(`https://api.spotify.com/v1/albums/${album.id}`);
    expect(res.status).toBe(401);
  });

  it("returns album, artist genres, search, and art bytes", async () => {
    const fs = createFakeSpotify([album]);

    const a = await (
      await fs.fetch(`https://api.spotify.com/v1/albums/${album.id}`, withToken)
    ).json();
    expect(a.name).toBe("Purple Rain");
    expect(a.release_date).toBe("1984-01-01");
    expect(a.artists[0].name).toBe("Prince");
    expect(a.images[0].url).toBe(fs.imageUrl(album.id));

    const ar = await (
      await fs.fetch(
        `https://api.spotify.com/v1/artists/${album.artist.id}`,
        withToken,
      )
    ).json();
    expect(ar.genres).toEqual(["funk", "pop"]);

    const s = await (
      await fs.fetch(
        "https://api.spotify.com/v1/search?type=album&q=purple",
        withToken,
      )
    ).json();
    expect(s.albums.items.map((i: { id: string }) => i.id)).toEqual([album.id]);

    const img = await fs.fetch(fs.imageUrl(album.id), withToken);
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe("JPEGDATA");
  });

  it("404s an unknown album", async () => {
    const fs = createFakeSpotify();
    expect(
      (await fs.fetch("https://api.spotify.com/v1/albums/nope", withToken))
        .status,
    ).toBe(404);
  });
});

describe("fake-spotify OAuth (Authorization Code + PKCE)", () => {
  const verifier = "a".repeat(64);
  const redirectUri = "http://127.0.0.1:4739/api/spotify/auth/callback";

  it("exchanges an auth code for user tokens when the PKCE verifier matches", async () => {
    const fs = createFakeSpotify([album]);
    const code = fs.issueAuthCode({
      codeChallenge: s256(verifier),
      redirectUri,
      scope: "user-read-playback-state streaming",
    });
    const res = await exchange(fs, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: "cid",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^fake-user-token-/);
    expect(body.refresh_token).toMatch(/^fake-refresh-/);
    expect(body.scope).toBe("user-read-playback-state streaming");
    expect(fs.hasRefreshToken(body.refresh_token)).toBe(true);

    // The minted user token is accepted by the Web API (client-credentials `fake-token` isn't the
    // only valid bearer any more).
    const api = await fs.fetch(
      `https://api.spotify.com/v1/albums/${album.id}`,
      {
        headers: { Authorization: `Bearer ${body.access_token}` },
      },
    );
    expect(api.status).toBe(200);
  });

  it("rejects a bad PKCE verifier or mismatched redirect URI", async () => {
    const fs = createFakeSpotify();
    const code = fs.issueAuthCode({
      codeChallenge: s256(verifier),
      redirectUri,
    });

    const badVerifier = await exchange(fs, {
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier",
      redirect_uri: redirectUri,
    });
    expect(badVerifier.status).toBe(400);
    expect((await badVerifier.json()).error).toBe("invalid_grant");

    const badRedirect = await exchange(fs, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "http://evil.example/callback",
    });
    expect(badRedirect.status).toBe(400);
  });

  it("rejects a reused (single-use) auth code", async () => {
    const fs = createFakeSpotify();
    const code = fs.issueAuthCode({
      codeChallenge: s256(verifier),
      redirectUri,
    });
    const first = await exchange(fs, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(first.status).toBe(200);
    const second = await exchange(fs, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(second.status).toBe(400);
  });

  it("refreshes an access token and rejects an unknown refresh token", async () => {
    const fs = createFakeSpotify();
    const code = fs.issueAuthCode({
      codeChallenge: s256(verifier),
      redirectUri,
    });
    const { refresh_token } = await (
      await exchange(fs, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      })
    ).json();

    const refreshed = await exchange(fs, {
      grant_type: "refresh_token",
      refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).access_token).toMatch(/^fake-user-token-/);
    expect(fs.refreshRequests()).toBe(1);

    const bad = await exchange(fs, {
      grant_type: "refresh_token",
      refresh_token: "nope",
    });
    expect(bad.status).toBe(400);
  });
});
