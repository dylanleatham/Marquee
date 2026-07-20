// Fake Spotify Web API for tests — a `fetch`-compatible function backed by an in-memory catalog.
// Fakes at the HTTP boundary (testing-strategy §3.1): the client's real request-building, auth,
// JSON parsing, and art download all run against it. Rule of thumb: a fake needs its own tests.
//
// Covers two auth models:
//   - client-credentials (app token) — POST /api/token with Basic auth, returns `fake-token`.
//   - Authorization Code + PKCE (user login, issue #23) — the browser `authorize` step is modelled
//     by `issueAuthCode()` (tests can't drive a real browser); the token endpoint then exchanges the
//     code (verifying the PKCE `code_verifier` against the stored S256 challenge) and refreshes.
import { createHash, randomUUID } from "node:crypto";

export interface FakeAlbum {
  id: string;
  name: string;
  artist: { id: string; name: string };
  year: number;
  genres: string[]; // artist genres (Spotify puts genres on the artist, not the album)
  artwork: Buffer; // bytes served at the album's image URL
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FakeSpotify {
  fetch: FetchLike;
  add(album: FakeAlbum): void;
  imageUrl(albumId: string): string;
  /** How many times the token endpoint was hit (for asserting token caching). */
  tokenRequests(): number;
  /** How many client-credentials (app-token) grants happened — 0 while a user session is used. */
  appTokenRequests(): number;
  /** How many `grant_type=refresh_token` exchanges happened (for asserting refresh caching). */
  refreshRequests(): number;
  /**
   * Model the browser authorize step: mint an auth code bound to a PKCE challenge + redirect URI,
   * exactly as Spotify would after the user consents. The token exchange later verifies the
   * `code_verifier` the client kept against `codeChallenge` (S256), so this exercises real PKCE.
   */
  issueAuthCode(opts: {
    codeChallenge: string;
    redirectUri: string;
    scope?: string;
  }): string;
  /** Whether a refresh token the fake issued is still valid (a disconnect can't be asserted here). */
  hasRefreshToken(token: string): boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function header(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const rec = h as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()] ?? undefined;
}

const formBody = (init: RequestInit | undefined): URLSearchParams => {
  const body = init?.body;
  return new URLSearchParams(typeof body === "string" ? body : "");
};

/** base64url(SHA-256(verifier)) — the PKCE `S256` challenge derivation (RFC 7636). */
const s256 = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

export function createFakeSpotify(initial: FakeAlbum[] = []): FakeSpotify {
  const albums = new Map<string, FakeAlbum>();
  const artists = new Map<
    string,
    { id: string; name: string; genres: string[] }
  >();
  const imageUrl = (id: string) => `https://i.scdn.co/image/${id}`;
  let tokenCount = 0;
  let appTokenCount = 0;
  let refreshCount = 0;

  // Access tokens the Web API will accept. `fake-token` is the app (client-credentials) token;
  // user tokens minted via the PKCE grants are added as they're issued.
  const validAccessTokens = new Set<string>(["fake-token"]);
  const authCodes = new Map<
    string,
    { codeChallenge: string; redirectUri: string; scope: string }
  >();
  const refreshTokens = new Map<string, { scope: string }>();

  const add = (a: FakeAlbum) => {
    albums.set(a.id, a);
    artists.set(a.artist.id, {
      id: a.artist.id,
      name: a.artist.name,
      genres: a.genres,
    });
  };
  initial.forEach(add);

  const issueAuthCode: FakeSpotify["issueAuthCode"] = ({
    codeChallenge,
    redirectUri,
    scope = "user-read-playback-state",
  }) => {
    const code = `fake-code-${randomUUID()}`;
    authCodes.set(code, { codeChallenge, redirectUri, scope });
    return code;
  };

  // Mint a fresh user access token (+ refresh token on the first grant) for a scope set.
  const issueUserTokens = (scope: string, refreshToken?: string) => {
    const accessToken = `fake-user-token-${randomUUID()}`;
    validAccessTokens.add(accessToken);
    const refresh = refreshToken ?? `fake-refresh-${randomUUID()}`;
    refreshTokens.set(refresh, { scope });
    return { accessToken, refresh, scope };
  };

  const albumBody = (a: FakeAlbum) => ({
    id: a.id,
    name: a.name,
    uri: `spotify:album:${a.id}`,
    release_date: `${a.year}-01-01`,
    artists: [{ id: a.artist.id, name: a.artist.name }],
    images: [{ url: imageUrl(a.id), width: 640, height: 640 }],
    genres: [] as string[],
  });

  // POST /api/token — dispatch on grant_type: client_credentials (app), authorization_code +
  // refresh_token (user login, PKCE). Returns Spotify-shaped token payloads or OAuth errors.
  const token = (init: RequestInit | undefined): Response => {
    tokenCount++;
    const form = formBody(init);
    const grant = form.get("grant_type");

    // Absent grant_type is treated as the app-token probe (the real client always sends
    // client_credentials with Basic auth; the fake's older callers omitted the body).
    if (grant === "client_credentials" || !grant) {
      const auth = header(init, "Authorization");
      if (!auth?.startsWith("Basic "))
        return json({ error: "invalid_client" }, 401);
      appTokenCount++;
      return json({
        access_token: "fake-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const rec = authCodes.get(code);
      if (!rec) return json({ error: "invalid_grant" }, 400);
      // PKCE: the verifier the client kept must hash to the challenge it sent at authorize time,
      // and the redirect URI must match — otherwise the grant is rejected exactly as Spotify would.
      if (
        s256(verifier) !== rec.codeChallenge ||
        redirectUri !== rec.redirectUri
      )
        return json({ error: "invalid_grant" }, 400);
      authCodes.delete(code); // single-use
      const { accessToken, refresh, scope } = issueUserTokens(rec.scope);
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refresh,
        scope,
      });
    }

    if (grant === "refresh_token") {
      refreshCount++;
      const refresh = form.get("refresh_token") ?? "";
      const rec = refreshTokens.get(refresh);
      if (!rec) return json({ error: "invalid_grant" }, 400);
      // Spotify may or may not rotate the refresh token; this fake keeps the same one (a client
      // must handle both, but reusing it is the common case) and issues a fresh access token.
      const { accessToken } = issueUserTokens(rec.scope, refresh);
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: rec.scope,
      });
    }

    return json({ error: "unsupported_grant_type" }, 400);
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    if (url.host === "accounts.spotify.com" && url.pathname === "/api/token")
      return token(init);

    if (url.host === "api.spotify.com") {
      const auth = header(init, "Authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!validAccessTokens.has(bearer)) {
        return json({ error: { status: 401, message: "no token" } }, 401);
      }
      const album = url.pathname.match(/^\/v1\/albums\/([^/]+)$/);
      if (album) {
        const a = albums.get(album[1]!);
        return a
          ? json(albumBody(a))
          : json({ error: { status: 404, message: "not found" } }, 404);
      }
      const artist = url.pathname.match(/^\/v1\/artists\/([^/]+)$/);
      if (artist) {
        const ar = artists.get(artist[1]!);
        return ar
          ? json({ id: ar.id, name: ar.name, genres: ar.genres })
          : json({ error: { status: 404 } }, 404);
      }
      if (url.pathname === "/v1/search") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const items = [...albums.values()]
          .filter(
            (a) =>
              a.name.toLowerCase().includes(q) ||
              a.artist.name.toLowerCase().includes(q),
          )
          .map(albumBody);
        return json({ albums: { items } });
      }
    }

    const img =
      url.host === "i.scdn.co" ? url.pathname.match(/^\/image\/(.+)$/) : null;
    if (img) {
      const a = albums.get(img[1]!);
      return a
        ? new Response(a.artwork, { headers: { "content-type": "image/jpeg" } })
        : new Response("", { status: 404 });
    }

    return json({ error: "unhandled", url: url.toString() }, 404);
  };

  return {
    fetch,
    add,
    imageUrl,
    tokenRequests: () => tokenCount,
    appTokenRequests: () => appTokenCount,
    refreshRequests: () => refreshCount,
    issueAuthCode,
    hasRefreshToken: (t) => refreshTokens.has(t),
  };
}
