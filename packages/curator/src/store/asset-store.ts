import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { Paths } from "./paths.js";
import { isCuratorId } from "../ids.js";
import type { AlbumAsset } from "../albums/asset.js";

/**
 * Bring a stored asset up to the current field names. Applied on every read, so the rest of Curator
 * only ever sees today's shape and the rewrite happens on whatever save comes next.
 *
 * ADR 0039 renamed `streamingEffect`/`streamingParams` to `patternOverride`/`patternOverrideParams`
 * when the streaming opt-in generalised into a picker over all seven pattern types. The legacy names
 * are read-only: nothing writes them, and they're dropped here so an album can't end up carrying two
 * answers that disagree.
 */
function migrate(asset: AlbumAsset): AlbumAsset {
  if (asset.streamingEffect !== undefined || asset.streamingParams) {
    asset.patternOverride ??= asset.streamingEffect;
    asset.patternOverrideParams ??= asset.streamingParams;
    delete asset.streamingEffect;
    delete asset.streamingParams;
    if (asset.patternOverride == null) delete asset.patternOverride;
    if (
      asset.patternOverrideParams &&
      Object.keys(asset.patternOverrideParams).length === 0
    )
      delete asset.patternOverrideParams;
  }
  return asset;
}

/**
 * The album-assets store: one {curatorId}.json per album under {dataDir}/album-assets. Human-
 * readable, git-friendly, `.bak` on every overwrite (curator-spec §6/§7). Source of truth.
 */
export class AssetStore {
  readonly paths: Paths;

  constructor(dataDir: string) {
    this.paths = new Paths(dataDir);
    mkdirSync(this.paths.albumAssets, { recursive: true });
  }

  exists(curatorId: string): boolean {
    if (!isCuratorId(curatorId)) return false;
    return existsSync(this.paths.assetFile(curatorId));
  }

  read(curatorId: string): AlbumAsset | null {
    // Guard against path traversal — curatorId reaches here straight from a URL param.
    if (!isCuratorId(curatorId)) return null;
    const file = this.paths.assetFile(curatorId);
    if (!existsSync(file)) return null;
    return migrate(JSON.parse(readFileSync(file, "utf8")) as AlbumAsset);
  }

  /** Write the asset. Keeps a `.bak` of the previous version before overwriting. */
  save(asset: AlbumAsset): void {
    if (!isCuratorId(asset.curatorId)) {
      throw new Error(
        `Refusing to save: invalid curatorId ${JSON.stringify(asset.curatorId)}`,
      );
    }
    const file = this.paths.assetFile(asset.curatorId);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeFileSync(file, JSON.stringify(asset, null, 2) + "\n");
  }

  /**
   * Apply a change to the album and persist it, re-reading the latest on-disk state first so a
   * concurrent write isn't clobbered. Read → mutate → save runs synchronously (no await between),
   * so it's atomic within one event-loop tick: two overlapping async actions each land their delta
   * on current state instead of overwriting a stale copy loaded before the other's save. Async
   * actions must therefore do their slow work first, then apply the result here. Returns the saved
   * asset, or `null` if it was deleted meanwhile.
   */
  update(
    curatorId: string,
    mutate: (asset: AlbumAsset) => void,
  ): AlbumAsset | null {
    const asset = this.read(curatorId);
    if (!asset) return null;
    mutate(asset);
    this.save(asset);
    return asset;
  }

  /**
   * All albums, newest first. Skips `.bak` and any unparseable files (logged by the caller).
   * O(n) synchronous read of every file per call — fine at personal-collection scale (hundreds
   * to low thousands, per curator-spec §5). Add a lookup index / cache if it ever grows past that.
   */
  list(): AlbumAsset[] {
    if (!existsSync(this.paths.albumAssets)) return [];
    const assets: AlbumAsset[] = [];
    for (const name of readdirSync(this.paths.albumAssets)) {
      if (!name.endsWith(".json") || name.endsWith(".bak")) continue;
      try {
        assets.push(
          migrate(
            JSON.parse(
              readFileSync(
                this.paths.assetFile(name.replace(/\.json$/, "")),
                "utf8",
              ),
            ) as AlbumAsset,
          ),
        );
      } catch {
        // Skip corrupt files; a real validate-on-read pass comes with schema validation.
      }
    }
    return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Find an album by its Spotify URI (dedup on add). */
  findBySpotifyUri(uri: string): AlbumAsset | null {
    return this.list().find((a) => a.metadata.spotifyUri === uri) ?? null;
  }

  /** Find an album by its Discogs URI (dedup on add). */
  findByDiscogsUri(uri: string): AlbumAsset | null {
    return this.list().find((a) => a.metadata.discogsUri === uri) ?? null;
  }

  /** Remove an album's asset file (and its `.bak`). Media removal is the caller's concern. */
  delete(curatorId: string): boolean {
    // Guard against path traversal — never rmSync a path built from an unvalidated id.
    if (!isCuratorId(curatorId)) return false;
    const file = this.paths.assetFile(curatorId);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    rmSync(`${file}.bak`, { force: true });
    return true;
  }
}
