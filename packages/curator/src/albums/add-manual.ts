import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { GeneratedPalettePayload } from "@marquee/palette-press";
import { generateCuratorId } from "../ids.js";
import type { AssetStore } from "../store/asset-store.js";
import type { Roadie } from "../roadie/worker.js";
import {
  buildFreshAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./asset.js";

export interface ManualAlbumInput {
  name: string;
  artist: string;
  year?: number;
  genres?: string[];
  artwork: Buffer;
}

/** Injectable so tests can avoid running node-vibrant; defaults to the real Palette Press. */
export type PaletteGenerator = (
  artwork: Buffer,
  metadata: {
    curatorId: string;
    name?: string;
    artist?: string;
    year?: number;
  },
) => Promise<GeneratedPalettePayload>;

export class ValidationError extends Error {}

/**
 * Add a manually-entered album: validate → assign curatorId → save the uploaded cover → write a
 * `fresh` asset and hand it to Roadie. Palette generation + prompt drafting happen off the request
 * path in Roadie's worker (roadie-spec §6); the response returns as soon as the album is queued.
 */
export async function addManualAlbum(
  deps: { store: AssetStore; roadie: Roadie },
  input: ManualAlbumInput,
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const name = input.name?.trim();
  const artist = input.artist?.trim();
  if (!name || !artist)
    throw new ValidationError("name and artist are required");
  if (!input.artwork || input.artwork.length === 0)
    throw new ValidationError("artwork is required");

  const curatorId = generateCuratorId((id) => deps.store.exists(id));

  // Manual albums have no Spotify art URL — the uploaded file is the source of truth. Write it now
  // so Roadie's generating_palette step (which reads from disk) is idempotent across restarts.
  const artworkAbs = deps.store.paths.artworkFile(curatorId);
  mkdirSync(deps.store.paths.artwork, { recursive: true });
  writeFileSync(artworkAbs, input.artwork);
  const contentHash =
    "sha256:" + createHash("sha256").update(input.artwork).digest("hex");

  const metadata: AlbumMetadata = {
    name,
    artist,
    source: "manual",
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.genres?.length ? { genres: input.genres } : {}),
  };

  const asset = buildFreshAsset({
    curatorId,
    metadata,
    artwork: {
      resolvedPath: deps.store.paths.relPosix(artworkAbs),
      contentHash,
    },
  });
  deps.store.save(asset);
  deps.roadie.enqueue(curatorId);
  return { curatorId, asset };
}
