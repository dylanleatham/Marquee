// Fake Discogs API for tests — a `fetch`-compatible function backed by an in-memory collection.
// Fakes at the HTTP boundary (testing-strategy §3.1): the client's real request-building, token
// auth, User-Agent, JSON parsing, pagination, and art download all run against it. Rule of thumb:
// a fake needs its own tests.
//
// Auth model: a single personal access token
// ([ADR 0017](../../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)).
// The fake accepts requests carrying `Authorization: Discogs token=<token>` for its configured
// token; anything else 401s exactly as Discogs would. Discogs also *requires* a User-Agent
// header — the fake enforces that too.

export interface FakeRelease {
  id: number;
  title: string;
  artist: string;
  year: number;
  genres: string[];
  styles?: string[];
  artwork: Buffer; // bytes served at the release's image URL
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FakeDiscogsOptions {
  token?: string;
  username?: string;
  userId?: number;
}

export interface FakeDiscogs {
  fetch: FetchLike;
  /** Add a release to the collection (and make its detail + image fetchable). */
  add(release: FakeRelease): void;
  imageUrl(releaseId: number): string;
  /** How many collection-page requests were served (for asserting pagination). */
  collectionRequests(): number;
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

export function createFakeDiscogs(
  initial: FakeRelease[] = [],
  opts: FakeDiscogsOptions = {},
): FakeDiscogs {
  const token = opts.token ?? "fake-discogs-token";
  const username = opts.username ?? "fake-user";
  const userId = opts.userId ?? 1;
  const releases = new Map<number, FakeRelease>();
  const imageUrl = (id: number) => `https://i.discogs.com/image/${id}.jpg`;
  let collectionCount = 0;

  const add = (r: FakeRelease) => releases.set(r.id, r);
  initial.forEach(add);

  const basicInformation = (r: FakeRelease) => ({
    id: r.id,
    title: r.title,
    year: r.year,
    thumb: imageUrl(r.id),
    cover_image: imageUrl(r.id),
    artists: [{ name: r.artist }],
    genres: r.genres,
    styles: r.styles ?? [],
  });

  const releaseBody = (r: FakeRelease) => ({
    id: r.id,
    title: r.title,
    year: r.year,
    artists: [{ name: r.artist }],
    genres: r.genres,
    styles: r.styles ?? [],
    images: [
      { type: "primary", uri: imageUrl(r.id), resource_url: imageUrl(r.id) },
    ],
  });

  // The collection endpoint paginates over the in-memory releases (insertion order).
  const collectionPage = (url: URL): Response => {
    collectionCount++;
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const perPage = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("per_page") ?? "50")),
    );
    const all = [...releases.values()];
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return json({
      pagination: { page, pages, per_page: perPage, items: all.length },
      releases: slice.map((r) => ({
        id: r.id,
        instance_id: r.id * 1000,
        basic_information: basicInformation(r),
      })),
    });
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    // Discogs rejects requests without a User-Agent.
    if (!header(init, "User-Agent"))
      return json({ message: "missing user-agent" }, 403);

    // Image host: no token needed in the fake, but the client still sends one.
    const img =
      url.host === "i.discogs.com"
        ? url.pathname.match(/^\/image\/(\d+)\.jpg$/)
        : null;
    if (img) {
      const r = releases.get(Number(img[1]));
      return r
        ? new Response(r.artwork, { headers: { "content-type": "image/jpeg" } })
        : new Response("", { status: 404 });
    }

    if (url.host !== "api.discogs.com")
      return json({ message: "unhandled", url: url.toString() }, 404);

    // Token auth on every API call.
    const auth = header(init, "Authorization") ?? "";
    if (auth !== `Discogs token=${token}`)
      return json({ message: "invalid token" }, 401);

    if (url.pathname === "/oauth/identity")
      return json({ id: userId, username, resource_url: "" });

    const coll = url.pathname.match(
      /^\/users\/([^/]+)\/collection\/folders\/0\/releases$/,
    );
    if (coll) {
      if (decodeURIComponent(coll[1]!) !== username)
        return json({ message: "not found" }, 404);
      return collectionPage(url);
    }

    const rel = url.pathname.match(/^\/releases\/(\d+)$/);
    if (rel) {
      const r = releases.get(Number(rel[1]));
      return r ? json(releaseBody(r)) : json({ message: "not found" }, 404);
    }

    return json({ message: "unhandled", url: url.toString() }, 404);
  };

  return {
    fetch,
    add,
    imageUrl,
    collectionRequests: () => collectionCount,
  };
}
