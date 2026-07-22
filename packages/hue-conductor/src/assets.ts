// Read the synced album-assets store at scan time (issue #45 / ADR 0019). This is the first time
// Conductor reads Curator's store (runtime-overview §5: "Conductor reads the album-assets store");
// until now it only accepted pre-built payloads on /api/playback. Injectable so tests seed albums
// without touching disk.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AlbumPaletteInput } from "@marquee/contracts";

/** Reads one album's palette-relevant fields by curatorId, or null if absent/unreadable. */
export interface AlbumAssetReader {
  read(curatorId: string): Promise<AlbumPaletteInput | null>;
}

const CURATOR_URI = /^curator:album:([a-z0-9]{8})$/;

/** Extract the curatorId from a `curator:album:<id>` URI, or null if it isn't one. */
export function curatorIdFromUri(uri: string): string | null {
  return uri.match(CURATOR_URI)?.[1] ?? null;
}

/**
 * Filesystem reader over the synced store at `{albumAssetsDir}/{curatorId}.json`. Async so the disk
 * read doesn't block Fastify's event loop on the always-on service (review: runtime). A missing or
 * unparseable file returns null rather than throwing — a scan for an album Conductor hasn't synced
 * yet must degrade gracefully (stay put), not error (runtime-overview §9).
 */
export class FsAlbumAssetReader implements AlbumAssetReader {
  constructor(private readonly dir: string) {}

  async read(curatorId: string): Promise<AlbumPaletteInput | null> {
    // curatorId reaches here from a scan URI — validate its shape before building a path from it.
    if (!/^[a-z0-9]{8}$/.test(curatorId)) return null;
    try {
      const raw = await readFile(join(this.dir, `${curatorId}.json`), "utf8");
      return JSON.parse(raw) as AlbumPaletteInput;
    } catch {
      // ENOENT (not synced) or bad JSON — both degrade to "stay put".
      return null;
    }
  }
}
