import { generateCuratorId } from "../ids.js";
import type { AssetStore } from "../store/asset-store.js";
import { publishNewAlbum, type NewAlbumDeps } from "./publish.js";
import { discogsUri } from "../discogs/client.js";
import {
  buildFreshAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./asset.js";
import { ValidationError } from "./add-manual.js";
import { DuplicateAlbumError } from "./add-spotify.js";

/**
 * A "have I already added this release?" lookup, `discogs:release:<id>` → curatorId.
 *
 * The default dedupe (`store.findByDiscogsUri`) reads every asset file on disk per call, which is
 * fine for one add from the collection browser and quadratic for a sweep of the whole collection
 * (issue #234): 500 releases × 500 files is a quarter-million reads to add 500 albums. A bulk caller
 * builds this once and passes it, so the sweep costs one pass over the store instead of one per row.
 */
export interface DiscogsIndex {
  get(uri: string): string | undefined;
  add(uri: string, curatorId: string): void;
}

/** Snapshot every already-added Discogs URI in one pass over the store. */
export function buildDiscogsIndex(store: AssetStore): DiscogsIndex {
  const byUri = new Map<string, string>();
  for (const asset of store.list()) {
    const uri = asset.metadata.discogsUri;
    if (uri) byUri.set(uri, asset.curatorId);
  }
  return {
    get: (uri) => byUri.get(uri),
    add: (uri, curatorId) => {
      byUri.set(uri, curatorId);
    },
  };
}

/**
 * The key a cross-source duplicate is caught on: the record itself, rather than any one source's id
 * for it ([#279](https://github.com/dylanleatham/Marquee/issues/279)).
 *
 * Normalisation is deliberately timid — lower-case and collapse whitespace, nothing else. It is what
 * found all eighteen real duplicates in the live library, and every step beyond it trades a false
 * negative for a false positive: strip punctuation and `DAMN.` merges with a hypothetical `DAMN`;
 * strip articles and `The The` stops being a band. A missed duplicate is a record to resolve later;
 * a wrong match is two different records the app refuses to let you own.
 */
export const albumKey = (title: string, artist: string): string =>
  `${title.trim().toLowerCase().replace(/\s+/g, " ")}\u0000${artist
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")}`;

const asIndex = (m: Map<string, string>): DiscogsIndex => ({
  get: (k) => m.get(k),
  add: (k, curatorId) => {
    m.set(k, curatorId);
  },
});

/**
 * Both dedupe views of the library, from **one** pass over the store.
 *
 * One pass, not two: the sweep rebuilds these every page, and `discogs-sync.test.ts` pins "reads the
 * store once per page, not once per row" — a second builder would quietly double the disk work that
 * test exists to bound.
 *
 * - `byUri` — Discogs release id. The precise match: same release, already swept.
 * - `byAlbum` — the record itself ([#279](https://github.com/dylanleatham/Marquee/issues/279)). The
 *   fallback for a record the library holds without a release id to match on.
 */
export function buildAlbumIndexes(store: AssetStore): {
  byUri: DiscogsIndex;
  byAlbum: DiscogsIndex;
} {
  const byUri = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const asset of store.list()) {
    const { discogsUri: uri, name, artist } = asset.metadata;
    if (uri) byUri.set(uri, asset.curatorId);
    if (name && artist) byKey.set(albumKey(name, artist), asset.curatorId);
  }
  return { byUri: asIndex(byUri), byAlbum: asIndex(byKey) };
}

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
 * request path (roadie-spec §6,
 * [ADR 0017](../../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)). The collection
 * row's display fields are stored as a first cut so the queue reads well immediately; Roadie
 * overwrites them with the authoritative release metadata.
 */
export async function addDiscogsAlbum(
  deps: NewAlbumDeps & { index?: DiscogsIndex },
  input: DiscogsAddInput,
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  const releaseId = Number(input.releaseId);
  if (!Number.isInteger(releaseId) || releaseId <= 0)
    throw new ValidationError("a valid Discogs releaseId is required");

  const uri = discogsUri(releaseId);
  // `??` would be wrong here: an index that answers "not present" must *end* the lookup, not fall
  // through to the full-store scan it exists to avoid.
  const existingId = deps.index
    ? deps.index.get(uri)
    : deps.store.findByDiscogsUri(uri)?.curatorId;
  if (existingId) throw new DuplicateAlbumError(existingId);

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
  // Indexed before publishing, so the in-memory dedup index can never be behind the saved album —
  // the sweep consults it for the very next row, and a window where the asset exists but is
  // unindexed is a second copy of the same release.
  deps.index?.add(uri, curatorId);
  return publishNewAlbum(deps, asset);
}
