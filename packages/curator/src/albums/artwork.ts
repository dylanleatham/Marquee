// Artwork override (curator-spec §3 in scope, §11 milestone 15, issue #100): when the fetched cover
// is a bad scan, upload your own and let everything downstream — palette, card art, video generation
// — derive from it instead.
//
// The rule this module exists to enforce: **read the active cover through `resolvedArtworkFile`,
// never through `paths.artworkFile`.** The fetched cover keeps its own slot on disk so removing an
// override reverts rather than re-downloads; only the *resolution* changes.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { relative } from "node:path";
import type { AssetStore } from "../store/asset-store.js";
import { toPosix } from "../store/paths.js";
import type { AlbumAsset } from "./asset.js";
import { detectImage, ImageError } from "../media/images.js";

/** Extension of the active override, derived from the stored resolved path. */
const overrideExt = (asset: AlbumAsset): string =>
  asset.artwork?.resolvedPath?.split(".").pop() ?? "jpg";

/**
 * The cover currently in force: the override when one is active, else the fetched art. Every reader
 * of album art goes through here — palette extraction, card-art and video generation, and the
 * artwork route — so an override is honoured everywhere rather than in whichever call site
 * remembered to check.
 */
export function resolvedArtworkFile(
  store: AssetStore,
  asset: AlbumAsset,
): string {
  return asset.artwork?.overrideActive
    ? store.paths.artworkOverrideFile(asset.curatorId, overrideExt(asset))
    : store.paths.artworkFile(asset.curatorId);
}

/** POSIX-relative path for the asset JSON, which stores paths portably (curator-spec §12 gotcha). */
const posixRelative = (store: AssetStore, abs: string): string =>
  toPosix(relative(store.paths.dataDir, abs));

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Save an uploaded cover as the album's override and re-point `artwork` at it.
 *
 * Does **not** touch the palette — that decision belongs to the caller, because
 * curator-spec §12 requires asking before a hand-edited palette is discarded. Returns the saved
 * asset so the route can regenerate (or deliberately not).
 */
export function applyArtworkOverride(
  store: AssetStore,
  curatorId: string,
  bytes: Buffer,
): AlbumAsset {
  const kind = detectImage(bytes);
  if (!kind) throw new ImageError("cover must be a PNG or JPEG");

  const abs = store.paths.artworkOverrideFile(curatorId, kind);
  mkdirSync(store.paths.artworkOverrides, { recursive: true });
  // Replacing an override of the other format would otherwise strand the old file and leave two
  // candidates on disk — remove any sibling before writing.
  for (const ext of ["png", "jpg"]) {
    const stale = store.paths.artworkOverrideFile(curatorId, ext);
    if (ext !== kind && existsSync(stale)) rmSync(stale, { force: true });
  }
  writeFileSync(abs, bytes);

  const saved = store.update(curatorId, (a) => {
    a.artwork = {
      resolvedPath: posixRelative(store, abs),
      overrideActive: true,
      contentHash: sha256(bytes),
    };
    a.roadie.flags.art_override_active = true;
  });
  if (!saved) throw new Error(`album ${curatorId} disappeared mid-override`);
  return saved;
}

/**
 * Drop the override and fall back to the fetched cover. The override file is deleted — keeping it
 * would leave `artwork-overrides/` accumulating images nothing points at, and re-uploading is the
 * documented way back.
 *
 * Returns `null` when there was no override to remove, so the route can 404 rather than pretend.
 */
export function removeArtworkOverride(
  store: AssetStore,
  curatorId: string,
): AlbumAsset | null {
  const asset = store.read(curatorId);
  if (!asset?.artwork?.overrideActive) return null;

  const abs = store.paths.artworkOverrideFile(curatorId, overrideExt(asset));
  if (existsSync(abs)) rmSync(abs, { force: true });

  const base = store.paths.artworkFile(curatorId);
  const hasBase = existsSync(base);
  const saved = store.update(curatorId, (a) => {
    a.roadie.flags.art_override_active = false;
    if (hasBase) {
      a.artwork = {
        resolvedPath: posixRelative(store, base),
        overrideActive: false,
        // The fetched cover's own hash — recomputed rather than remembered, so this stays correct
        // even for albums whose override predates this field being tracked.
        contentHash: sha256(readFileSync(base)),
      };
    } else {
      // A manual album may never have had a fetched cover: removing the override leaves it with no
      // art at all, which the queue and detail views already render as the initials placeholder.
      delete a.artwork;
    }
  });
  if (!saved) throw new Error(`album ${curatorId} disappeared mid-override`);
  return saved;
}
