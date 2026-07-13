import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { generatePalette } from "@marquee/palette-press";
import { generateCuratorId } from "../ids.js";
import type { AssetStore } from "../store/asset-store.js";
import type { SpotifyClient } from "../spotify/client.js";
import {
  buildAlbumAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./asset.js";
import { ValidationError, type PaletteGenerator } from "./add-manual.js";

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
 * Add an album from Spotify: fetch metadata + art, dedup on the Spotify URI, download the cover,
 * run Palette Press, and write the asset (source "spotify", state awaiting_review).
 */
export async function addSpotifyAlbum(
  deps: {
    store: AssetStore;
    spotify: SpotifyClient;
    generate?: PaletteGenerator;
  },
  input: { spotifyUri?: string; spotifyId?: string },
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const generate = deps.generate ?? generatePalette;
  const spotifyId = parseAlbumId(input);
  if (!spotifyId)
    throw new ValidationError("a valid spotifyUri or spotifyId is required");

  const meta = await deps.spotify.getAlbum(spotifyId);

  const existing = deps.store.findBySpotifyUri(meta.spotifyUri);
  if (existing) throw new DuplicateAlbumError(existing.curatorId);
  if (!meta.artUrl)
    throw new ValidationError(
      "album has no cover art on Spotify — add it manually",
    );

  const art = await deps.spotify.downloadArt(meta.artUrl);
  const curatorId = generateCuratorId((id) => deps.store.exists(id));

  const artworkAbs = deps.store.paths.artworkFile(curatorId);
  mkdirSync(deps.store.paths.artwork, { recursive: true });
  writeFileSync(artworkAbs, art);
  const contentHash =
    "sha256:" + createHash("sha256").update(art).digest("hex");

  const palette = await generate(art, {
    curatorId,
    name: meta.name,
    artist: meta.artist,
    year: meta.year,
  });

  const metadata: AlbumMetadata = {
    name: meta.name,
    artist: meta.artist,
    source: "spotify",
    spotifyUri: meta.spotifyUri,
    spotifyArtUrl: meta.artUrl,
    ...(meta.year !== undefined ? { year: meta.year } : {}),
    ...(meta.genres.length ? { genres: meta.genres } : {}),
  };

  const asset = buildAlbumAsset({
    curatorId,
    metadata,
    artworkPosixPath: deps.store.paths.relPosix(artworkAbs),
    contentHash,
    palette,
  });
  deps.store.save(asset);
  return { curatorId, asset };
}
