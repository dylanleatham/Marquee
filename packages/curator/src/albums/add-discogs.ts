import { generateCuratorId } from "../ids.js";
import type { AssetStore } from "../store/asset-store.js";
import type { Roadie } from "../roadie/worker.js";
import { discogsUri } from "../discogs/client.js";
import {
  buildFreshAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./asset.js";
import { ValidationError } from "./add-manual.js";
import { DuplicateAlbumError } from "./add-spotify.js";

/** What the collection browser hands off when the user clicks "Send to Roadie". */
export interface DiscogsAddInput {
  releaseId: number;
  /** Optional display fields from the collection row — so the queue reads well before Roadie's fetch
   *  fills authoritative metadata. All are refreshed from the release detail in `fetching_metadata`. */
  title?: string;
  artist?: string;
  year?: number;
  genres?: string[];
  coverImage?: string;
}

/**
 * Add an album from the user's Discogs collection. Dedups on the (stable) Discogs release id up
 * front — no fetch needed to reject a duplicate — then writes a `fresh` asset and hands it to Roadie,
 * which fetches the release detail, downloads the cover art, and generates the palette off the
 * request path (roadie-spec §6, ADR 0016). The collection row's display fields are stored as a
 * first cut so the queue reads well immediately; Roadie overwrites them with the authoritative
 * release metadata.
 */
export async function addDiscogsAlbum(
  deps: { store: AssetStore; roadie: Roadie },
  input: DiscogsAddInput,
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const releaseId = Number(input.releaseId);
  if (!Number.isInteger(releaseId) || releaseId <= 0)
    throw new ValidationError("a valid Discogs releaseId is required");

  const uri = discogsUri(releaseId);
  const existing = deps.store.findByDiscogsUri(uri);
  if (existing) throw new DuplicateAlbumError(existing.curatorId);

  const curatorId = generateCuratorId((id) => deps.store.exists(id));

  // name/artist are the collection row's values until Roadie's fetching_metadata step refreshes them.
  const metadata: AlbumMetadata = {
    name: input.title?.trim() ?? "",
    artist: input.artist?.trim() ?? "",
    source: "discogs",
    discogsReleaseId: releaseId,
    discogsUri: uri,
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.genres?.length ? { genres: input.genres } : {}),
    ...(input.coverImage ? { discogsArtUrl: input.coverImage } : {}),
  };

  const asset = buildFreshAsset({ curatorId, metadata });
  deps.store.save(asset);
  deps.roadie.enqueue(curatorId);
  return { curatorId, asset };
}
