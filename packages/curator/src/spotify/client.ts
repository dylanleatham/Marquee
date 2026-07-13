import { Buffer } from "node:buffer";

/** A `fetch`-shaped function — injectable so tests use fake-spotify instead of the network. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SpotifyAlbumMeta {
  spotifyId: string;
  spotifyUri: string;
  name: string;
  artist: string;
  year?: number;
  genres: string[];
  artUrl?: string;
}

export interface SpotifyClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  apiBase?: string;
  accountsBase?: string;
  now?: () => number;
}

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpotifyError";
  }
}

interface AlbumResponse {
  id: string;
  name: string;
  uri?: string;
  release_date?: string;
  artists: Array<{ id: string; name: string }>;
  images?: Array<{ url: string }>;
  genres?: string[];
}

/**
 * Thin Spotify Web API client using the client-credentials flow (no user login). Reads public
 * catalog metadata + cover art; genres come from the artist endpoint (Spotify doesn't put them
 * on the album). Token is cached until shortly before expiry.
 */
export class SpotifyClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly accountsBase: string;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly opts: SpotifyClientOptions) {
    this.fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.apiBase = opts.apiBase ?? "https://api.spotify.com";
    this.accountsBase = opts.accountsBase ?? "https://accounts.spotify.com";
    this.now = opts.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now())
      return this.token.value;
    const basic = Buffer.from(
      `${this.opts.clientId}:${this.opts.clientSecret}`,
    ).toString("base64");
    const res = await this.fetch(`${this.accountsBase}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok)
      throw new SpotifyError(`Spotify auth failed (${res.status})`, res.status);
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  private async api<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) throw new SpotifyError(`Not found: ${path}`, 404);
    if (!res.ok)
      throw new SpotifyError(
        `Spotify API ${res.status} on ${path}`,
        res.status,
      );
    return (await res.json()) as T;
  }

  private normalize(a: AlbumResponse, genres: string[]): SpotifyAlbumMeta {
    return {
      spotifyId: a.id,
      spotifyUri: a.uri ?? `spotify:album:${a.id}`,
      name: a.name,
      artist: a.artists[0]?.name ?? "Unknown",
      year: a.release_date ? Number(a.release_date.slice(0, 4)) : undefined,
      genres,
      artUrl: a.images?.[0]?.url,
    };
  }

  async getAlbum(spotifyId: string): Promise<SpotifyAlbumMeta> {
    const album = await this.api<AlbumResponse>(
      `/v1/albums/${encodeURIComponent(spotifyId)}`,
    );
    let genres = album.genres ?? [];
    const artistId = album.artists[0]?.id;
    if (genres.length === 0 && artistId) {
      try {
        genres =
          (await this.api<{ genres: string[] }>(`/v1/artists/${artistId}`))
            .genres ?? [];
      } catch {
        genres = []; // genres are best-effort — never fail an add over them
      }
    }
    return this.normalize(album, genres);
  }

  async searchAlbums(query: string, limit = 10): Promise<SpotifyAlbumMeta[]> {
    const r = await this.api<{ albums: { items: AlbumResponse[] } }>(
      `/v1/search?type=album&limit=${limit}&q=${encodeURIComponent(query)}`,
    );
    return r.albums.items.map((a) => this.normalize(a, []));
  }

  async downloadArt(url: string): Promise<Buffer> {
    const res = await this.fetch(url);
    if (!res.ok)
      throw new SpotifyError(`Art download failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
