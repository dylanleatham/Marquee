import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  generatePalette,
  type GeneratedPalettePayload,
} from "@marquee/palette-press";
import { generateCuratorId } from "../ids.js";
import type { AssetStore } from "../store/asset-store.js";
import {
  buildManualAsset,
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
 * The step-3 "add to palette-saved" flow: validate → assign curatorId → save cover art →
 * run Palette Press → write the asset file. Synchronous for now; Roadie (step 5) will move
 * palette generation into a background worker and add metadata/prompt steps.
 */
export async function addManualAlbum(
  deps: { store: AssetStore; generate?: PaletteGenerator },
  input: ManualAlbumInput,
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const generate = deps.generate ?? generatePalette;
  const name = input.name?.trim();
  const artist = input.artist?.trim();
  if (!name || !artist)
    throw new ValidationError("name and artist are required");
  if (!input.artwork || input.artwork.length === 0)
    throw new ValidationError("artwork is required");

  const curatorId = generateCuratorId((id) => deps.store.exists(id));

  // Manual albums have no Spotify art URL — the local file is the source of truth.
  const artworkAbs = deps.store.paths.artworkFile(curatorId);
  mkdirSync(deps.store.paths.artwork, { recursive: true });
  writeFileSync(artworkAbs, input.artwork);
  const contentHash =
    "sha256:" + createHash("sha256").update(input.artwork).digest("hex");

  const palette = await generate(input.artwork, {
    curatorId,
    name,
    artist,
    year: input.year,
  });

  const metadata: AlbumMetadata = {
    name,
    artist,
    source: "manual",
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.genres?.length ? { genres: input.genres } : {}),
  };

  const asset = buildManualAsset({
    curatorId,
    metadata,
    artworkPosixPath: deps.store.paths.relPosix(artworkAbs),
    contentHash,
    palette,
  });
  deps.store.save(asset);
  return { curatorId, asset };
}
