// Fake Spotify Web API for tests — a `fetch`-compatible function backed by an in-memory catalog.
// Fakes at the HTTP boundary (testing-strategy §3.1): the client's real request-building, auth,
// JSON parsing, and art download all run against it. Rule of thumb: a fake needs its own tests.

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

export function createFakeSpotify(initial: FakeAlbum[] = []): FakeSpotify {
  const albums = new Map<string, FakeAlbum>();
  const artists = new Map<
    string,
    { id: string; name: string; genres: string[] }
  >();
  const imageUrl = (id: string) => `https://i.scdn.co/image/${id}`;
  let tokenCount = 0;

  const add = (a: FakeAlbum) => {
    albums.set(a.id, a);
    artists.set(a.artist.id, {
      id: a.artist.id,
      name: a.artist.name,
      genres: a.genres,
    });
  };
  initial.forEach(add);

  const albumBody = (a: FakeAlbum) => ({
    id: a.id,
    name: a.name,
    uri: `spotify:album:${a.id}`,
    release_date: `${a.year}-01-01`,
    artists: [{ id: a.artist.id, name: a.artist.name }],
    images: [{ url: imageUrl(a.id), width: 640, height: 640 }],
    genres: [] as string[],
  });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    if (url.host === "accounts.spotify.com" && url.pathname === "/api/token") {
      tokenCount++;
      const auth = header(init, "Authorization");
      if (!auth?.startsWith("Basic "))
        return json({ error: "invalid_client" }, 401);
      return json({
        access_token: "fake-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    if (url.host === "api.spotify.com") {
      if (header(init, "Authorization") !== "Bearer fake-token") {
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

  return { fetch, add, imageUrl, tokenRequests: () => tokenCount };
}
