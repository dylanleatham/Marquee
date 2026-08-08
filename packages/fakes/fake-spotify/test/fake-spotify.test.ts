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

  // The tracklist backs Curator's demo-track picker (ADR 0058). Paging is modelled for real, since
  // the client's page loop is bounded and a single-page fake would never reach that boundary.
  describe("album tracks", () => {
    const withTracks: FakeAlbum = {
      ...album,
      tracks: [
        { id: "t1", name: "Let's Go Crazy", durationMs: 279_000 },
        { id: "t2", name: "Take Me With U" },
        { name: "A Local File" }, // no id — unplayable, and the client must drop it
      ],
    };

    it("serves a page with track numbers, URIs and a null next", async () => {
      const fs = createFakeSpotify([withTracks]);
      const r = await (
        await fs.fetch(
          `https://api.spotify.com/v1/albums/${album.id}/tracks?limit=50&offset=0`,
          withToken,
        )
      ).json();

      expect(r.total).toBe(3);
      expect(r.next).toBeNull();
      expect(r.items[0]).toMatchObject({
        id: "t1",
        uri: "spotify:track:t1",
        name: "Let's Go Crazy",
        track_number: 1,
        disc_number: 1,
        duration_ms: 279_000,
      });
      expect(r.items[2].id).toBeNull();
    });

    it("honours limit/offset and sets next while more remain", async () => {
      const fs = createFakeSpotify([withTracks]);
      const page = async (offset: number) =>
        (
          await fs.fetch(
            `https://api.spotify.com/v1/albums/${album.id}/tracks?limit=2&offset=${offset}`,
            withToken,
          )
        ).json();

      const first = await page(0);
      expect(first.items).toHaveLength(2);
      expect(first.next).toContain("offset=2");

      const second = await page(2);
      expect(second.items.map((t: { name: string }) => t.name)).toEqual([
        "A Local File",
      ]);
      // Track numbers continue across pages rather than restarting at 1.
      expect(second.items[0].track_number).toBe(3);
      expect(second.next).toBeNull();
    });

    it("serves an empty list for an album with no tracklist, and 404s an unknown one", async () => {
      const fs = createFakeSpotify([album]);
      const r = await (
        await fs.fetch(
          `https://api.spotify.com/v1/albums/${album.id}/tracks`,
          withToken,
        )
      ).json();
      expect(r.items).toEqual([]);
      expect(r.total).toBe(0);
      expect(
        (
          await fs.fetch(
            "https://api.spotify.com/v1/albums/nope/tracks",
            withToken,
          )
        ).status,
      ).toBe(404);
    });
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

/**
 * Search is token-wise because that is how the real API behaves and how callers use it: Curator's
 * Discogs→Spotify match searches `"<artist> <title>"`. A substring-of-the-title fake never matched
 * those, so a lookup that succeeds against real Spotify came back empty in tests — the fake was
 * lying in the direction that hides bugs.
 */
describe("fake-spotify search", () => {
  const withToken = { headers: { Authorization: "Bearer fake-token" } };
  const search = async (q: string) =>
    (
      await createFakeSpotify([album]).fetch(
        `https://api.spotify.com/v1/search?type=album&q=${encodeURIComponent(q)}`,
        withToken,
      )
    ).json();

  it("matches an artist-plus-title query, the way callers actually search", async () => {
    expect((await search("Prince Purple Rain")).albums.items).toHaveLength(1);
  });

  it("still matches a single token from either field", async () => {
    expect((await search("purple")).albums.items).toHaveLength(1);
    expect((await search("prince")).albums.items).toHaveLength(1);
  });

  it("requires every token, so an unrelated word rules an album out", async () => {
    expect(
      (await search("Prince Purple Rain Remastered")).albums.items,
    ).toEqual([]);
  });

  it("returns nothing for an empty query rather than the whole catalog", async () => {
    expect((await search("   ")).albums.items).toEqual([]);
  });
});
