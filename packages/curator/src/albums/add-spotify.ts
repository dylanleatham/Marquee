import { generateCuratorId } from "../ids.js";
import { publishNewAlbum, type NewAlbumDeps } from "./publish.js";
import {
  buildFreshAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./asset.js";
import { ValidationError } from "./add-manual.js";

/** Adding an album already in the collection (same Spotify URI). Surfaced as 409. */
export class DuplicateAlbumError extends Error {
  constructor(readonly curatorId: string) {
    super(`Album already added as ${curatorId}`);
    this.name = "DuplicateAlbumError";
  }
}

const SPOTIFY_ALBUM_URI = /^spotify:album:([A-Za-z0-9]+)$/;

/** Accept either a raw album id or a `spotify:album:<id>` URI. */
export function parseAlbumId(input: {
  spotifyUri?: string;
  spotifyId?: string;
}): string | null {
  if (input.spotifyId) return input.spotifyId;
  const m = input.spotifyUri?.match(SPOTIFY_ALBUM_URI);
  return m ? m[1]! : null;
}

/**
 * Add an album from Spotify. Dedups on the (normalized) Spotify URI up front — no fetch needed to
 * reject a duplicate — then writes a `fresh` asset and hands it to Roadie, which fetches metadata,
 * downloads art, and generates the palette off the request path (roadie-spec §6).
 */
export async function addSpotifyAlbum(
  deps: NewAlbumDeps,
  input: { spotifyUri?: string; spotifyId?: string },
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const spotifyId = parseAlbumId(input);
  if (!spotifyId)
    throw new ValidationError("a valid spotifyUri or spotifyId is required");
  const spotifyUri = `spotify:album:${spotifyId}`;

  const existing = deps.store.findBySpotifyUri(spotifyUri);
  if (existing) throw new DuplicateAlbumError(existing.curatorId);

  const curatorId = generateCuratorId((id) => deps.store.exists(id));

  // name/artist are placeholders until Roadie's fetching_metadata step fills them in.
  const metadata: AlbumMetadata = {
    name: "",
    artist: "",
    source: "spotify",
    spotifyUri,
  };

  const asset = buildFreshAsset({ curatorId, metadata });
  return publishNewAlbum(deps, asset);
}
