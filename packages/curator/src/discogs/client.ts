import { Buffer } from "node:buffer";

/** A `fetch`-shaped function — injectable so tests use fake-discogs instead of the network. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One album in a user's Discogs collection (from the paginated collection endpoint). */
export interface DiscogsCollectionItem {
  /** The Discogs release id — the stable identity we dedupe + fetch detail on. */
  releaseId: number;
  /** `discogs:release:<id>` — parallel to Spotify's `spotify:album:<id>`. */
  discogsUri: string;
  title: string;
  artist: string;
  year?: number;
  genres: string[];
  /** Full-size cover image (may require auth to fetch); `thumb` is the small preview. */
  coverImage?: string;
  thumb?: string;
}

/** A page of collection results plus enough pagination info for the caller to fetch the rest. */
export interface DiscogsCollectionPage {
  items: DiscogsCollectionItem[];
  page: number;
  pages: number;
  perPage: number;
  total: number;
}

/** A single Discogs release's detail — metadata + the primary cover image we feed to Palette Press. */
export interface DiscogsReleaseMeta {
  releaseId: number;
  discogsUri: string;
  title: string;
  artist: string;
  year?: number;
  genres: string[];
  /** The primary image URL, or the first image if none is flagged primary. */
  artUrl?: string;
}

export interface DiscogsClientOptions {
  /** Personal access token (ADR 0016) — sent as `Authorization: Discogs token=<token>`. Provide this
   * OR `authHeader` (OAuth 1.0a, issue #59); `authHeader` wins when both are present. */
  token?: string;
  /** Supplies the full `Authorization` header value per request — used for the OAuth 1.0a session
   * (issue #59), which signs each request with a fresh nonce/timestamp. Returning `undefined` falls
   * back to the personal token. */
  authHeader?: () => string | undefined;
  fetch?: FetchLike;
  apiBase?: string;
  /**
   * Discogs *requires* a descriptive User-Agent and rejects requests without one; overridable so a
   * fork can identify itself. Defaults to a Marquee identifier.
   */
  userAgent?: string;
  now?: () => number;
  /** Per-request timeout (ms). A hung Discogs connection must fail fast, not hang the request. */
  timeoutMs?: number;
}

export class DiscogsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscogsError";
  }
}

// --- Raw Discogs response shapes (only the fields we read) ---

interface IdentityResponse {
  id: number;
  username: string;
}

interface BasicInformation {
  id: number;
  title: string;
  year?: number;
  thumb?: string;
  cover_image?: string;
  artists?: Array<{ name: string }>;
  genres?: string[];
  styles?: string[];
}

interface CollectionReleaseResponse {
  id: number;
  basic_information: BasicInformation;
}

interface CollectionPageResponse {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  releases: CollectionReleaseResponse[];
}

interface ReleaseImage {
  type?: "primary" | "secondary";
  uri?: string;
  resource_url?: string;
}

interface ReleaseResponse {
  id: number;
  title: string;
  year?: number;
  artists?: Array<{ name: string }>;
  genres?: string[];
  styles?: string[];
  images?: ReleaseImage[];
}

export const discogsUri = (releaseId: number): string =>
  `discogs:release:${releaseId}`;

/** Discogs joins multiple artists with " & " on the artist credit; mirror that when normalizing. */
const joinArtists = (artists?: Array<{ name: string }>): string =>
  artists && artists.length
    ? artists
        .map((a) => a.name)
        .filter(Boolean)
        .join(", ")
    : "Unknown";

/** Genres + styles both describe the record; merge them (deduped) since Curator has one genres list. */
const mergeGenres = (genres?: string[], styles?: string[]): string[] => [
  ...new Set([...(genres ?? []), ...(styles ?? [])]),
];

/**
 * Thin Discogs API client using a personal access token (ADR 0016 — no OAuth 1.0a for a single-user
 * home app). Reads the logged-in user's identity + collection and per-release detail (metadata +
 * cover image). Injectable `fetch`; every request carries the required User-Agent and a timeout.
 */
export class DiscogsClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DiscogsClientOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? "https://api.discogs.com";
    this.userAgent =
      opts.userAgent ?? "Marquee/1.0 +https://github.com/marquee";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (!opts.token && !opts.authHeader)
      throw new Error("DiscogsClient needs a token or an authHeader provider");
  }

  /** The Authorization header for a request: an OAuth 1.0a session when connected, else the personal
   * token (issue #59). */
  private authorization(): string {
    const oauth = this.opts.authHeader?.();
    if (oauth) return oauth;
    if (this.opts.token) return `Discogs token=${this.opts.token}`;
    throw new DiscogsError("Discogs is not authenticated", 401);
  }

  /** fetch with an AbortController timeout + the headers Discogs requires on every request. */
  private async fetchT(
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetch(input, {
        ...init,
        signal: ctrl.signal,
        headers: {
          "User-Agent": this.userAgent,
          Authorization: this.authorization(),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new DiscogsError(
          `Discogs request timed out after ${this.timeoutMs}ms`,
          504,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchT(`${this.apiBase}${path}`);
    if (res.status === 404) throw new DiscogsError(`Not found: ${path}`, 404);
    if (!res.ok)
      throw new DiscogsError(
        `Discogs API ${res.status} on ${path}`,
        res.status,
      );
    return (await res.json()) as T;
  }

  /** The token's owner. Used to resolve the collection username when it isn't configured. */
  async getIdentity(): Promise<{ id: number; username: string }> {
    const id = await this.api<IdentityResponse>("/oauth/identity");
    return { id: id.id, username: id.username };
  }

  private normalizeItem(r: CollectionReleaseResponse): DiscogsCollectionItem {
    const b = r.basic_information;
    return {
      releaseId: b.id,
      discogsUri: discogsUri(b.id),
      title: b.title,
      artist: joinArtists(b.artists),
      ...(b.year ? { year: b.year } : {}),
      genres: mergeGenres(b.genres, b.styles),
      ...(b.cover_image ? { coverImage: b.cover_image } : {}),
      ...(b.thumb ? { thumb: b.thumb } : {}),
    };
  }

  /**
   * One page of the user's collection (folder 0 = "All"). Discogs paginates; the caller reads
   * `pages`/`page` to fetch the rest. `perPage` is capped at 100 by Discogs.
   */
  async getCollection(
    username: string,
    opts: { page?: number; perPage?: number } = {},
  ): Promise<DiscogsCollectionPage> {
    const page = opts.page ?? 1;
    const perPage = Math.min(opts.perPage ?? 50, 100);
    const r = await this.api<CollectionPageResponse>(
      `/users/${encodeURIComponent(username)}/collection/folders/0/releases` +
        `?page=${page}&per_page=${perPage}`,
    );
    return {
      items: r.releases.map((rel) => this.normalizeItem(rel)),
      page: r.pagination.page,
      pages: r.pagination.pages,
      perPage: r.pagination.per_page,
      total: r.pagination.items,
    };
  }

  private normalizeRelease(r: ReleaseResponse): DiscogsReleaseMeta {
    const primary =
      r.images?.find((i) => i.type === "primary") ?? r.images?.[0];
    return {
      releaseId: r.id,
      discogsUri: discogsUri(r.id),
      title: r.title,
      artist: joinArtists(r.artists),
      ...(r.year ? { year: r.year } : {}),
      genres: mergeGenres(r.genres, r.styles),
      ...(primary?.uri ? { artUrl: primary.uri } : {}),
    };
  }

  /** Full metadata + cover image for one release. */
  async getRelease(releaseId: number): Promise<DiscogsReleaseMeta> {
    const r = await this.api<ReleaseResponse>(
      `/releases/${encodeURIComponent(String(releaseId))}`,
    );
    return this.normalizeRelease(r);
  }

  /** Download a cover image. Discogs image hosts require the same auth + User-Agent as the API. */
  async downloadArt(url: string): Promise<Buffer> {
    const res = await this.fetchT(url);
    if (!res.ok)
      throw new DiscogsError(`Art download failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
