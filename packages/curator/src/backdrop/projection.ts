// The Curator → Backdrop projection (runtime-overview §4, roadie-spec §6). Backdrop doesn't see the
// full album asset — only a URI → video-file map (its library.json). This module turns an AlbumAsset
// into the single library entry Backdrop needs. Pure and tiny so it's trivially unit-testable; all
// I/O (HTTP push, file copy) lives in client.ts / sync.ts.
import { posix } from "node:path";
import type { LibraryEntry } from "@marquee/contracts";
import type { AlbumAsset } from "../albums/asset.js";

/** The runtime scan URI for an album — the key Backdrop resolves a scan against (runtime-overview §5). */
export const albumUri = (curatorId: string): string =>
  `curator:album:${curatorId}`;

/** A library entry plus the `uri` key, matching library-entry.schema.json (`{ uri } & LibraryEntry`). */
export type LibraryEntryWithUri = { uri: string } & LibraryEntry;

/**
 * Build the Backdrop library entry for an album, or `null` when there's nothing to play yet (no
 * visualizer attached). `backdropMediaDir` is where the visualizer file lives *on the Backdrop host*
 * — Backdrop rejects any filePath outside its own media dir, so the projection must name the file at
 * its synced location, not Curator's local path. The filename mirrors Curator's `visualizers/{fileId}.mp4`
 * layout, which the file sync (rsync/local copy) reproduces under `backdropMediaDir`.
 */
export function buildLibraryEntry(
  asset: AlbumAsset,
  backdropMediaDir: string,
): LibraryEntryWithUri | null {
  const vis = asset.visualizer;
  if (!vis) return null;
  // Always POSIX, regardless of the OS Curator runs on: the Backdrop host is Linux and its filePath
  // check is separator-sensitive. Replace backslashes explicitly rather than via the platform `sep`
  // (store/paths' toPosix) — Curator on Windows would otherwise emit a `C:\…\file.mp4` filePath that
  // Backdrop can't resolve, and the same code must behave identically on the CI (Linux) box.
  const posixDir = backdropMediaDir.replace(/\\/g, "/");
  const filePath = posix.join(posixDir, `${vis.fileId}.mp4`);
  // No contentHash: the contract's field is a *video* hash (change-detection for re-push), which
  // Curator doesn't compute yet — the album-art hash would be the wrong value. Omit rather than lie.
  return {
    uri: albumUri(asset.curatorId),
    filePath,
    ...(vis.durationSec !== undefined ? { durationSec: vis.durationSec } : {}),
  };
}
