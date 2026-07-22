// Read the synced album-assets store at scan time (issue #45 / ADR 0019). This is the first time
// Conductor reads Curator's store (runtime-overview §5: "Conductor reads the album-assets store");
// until now it only accepted pre-built payloads on /api/playback. Injectable so tests seed albums
// without touching disk.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AlbumPaletteInput } from "@marquee/contracts";

/** Reads one album's palette-relevant fields by curatorId, or null if absent/unreadable. */
export interface AlbumAssetReader {
  read(curatorId: string): AlbumPaletteInput | null;
}

const CURATOR_URI = /^curator:album:([a-z0-9]{8})$/;

/** Extract the curatorId from a `curator:album:<id>` URI, or null if it isn't one. */
export function curatorIdFromUri(uri: string): string | null {
  return uri.match(CURATOR_URI)?.[1] ?? null;
}

/**
 * Filesystem reader over the synced store at `{albumAssetsDir}/{curatorId}.json`. A missing or
 * unparseable file returns null rather than throwing — a scan for an album Conductor hasn't synced
 * yet must degrade gracefully (stay put), not error (runtime-overview §9).
 */
export class FsAlbumAssetReader implements AlbumAssetReader {
  constructor(private readonly dir: string) {}

  read(curatorId: string): AlbumPaletteInput | null {
    // curatorId reaches here from a scan URI — validate its shape before building a path from it.
    if (!/^[a-z0-9]{8}$/.test(curatorId)) return null;
    const file = join(this.dir, `${curatorId}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as AlbumPaletteInput;
    } catch {
      return null;
    }
  }
}
