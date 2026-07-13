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
    return existsSync(this.paths.assetFile(curatorId));
  }

  read(curatorId: string): AlbumAsset | null {
    const file = this.paths.assetFile(curatorId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as AlbumAsset;
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

  /** All albums, newest first. Skips `.bak` and any unparseable files (logged by the caller). */
  list(): AlbumAsset[] {
    if (!existsSync(this.paths.albumAssets)) return [];
    const assets: AlbumAsset[] = [];
    for (const name of readdirSync(this.paths.albumAssets)) {
      if (!name.endsWith(".json") || name.endsWith(".bak")) continue;
      try {
        assets.push(
          JSON.parse(
            readFileSync(
              this.paths.assetFile(name.replace(/\.json$/, "")),
              "utf8",
            ),
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

  /** Remove an album's asset file (and its `.bak`). Media removal is the caller's concern. */
  delete(curatorId: string): boolean {
    const file = this.paths.assetFile(curatorId);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    rmSync(`${file}.bak`, { force: true });
    return true;
  }
}
