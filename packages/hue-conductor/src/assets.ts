// Read the synced album-assets store at scan time (issue #45 / ADR 0019). This is the first time
// Conductor reads Curator's store (runtime-overview §5: "Conductor reads the album-assets store");
// until now it only accepted pre-built payloads on /api/playback. Injectable so tests seed albums
// without touching disk.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCuratorUri, type AlbumPaletteInput } from "@marquee/contracts";

/** Reads one album's palette-relevant fields by curatorId, or null if absent/unreadable. */
export interface AlbumAssetReader {
  read(curatorId: string): Promise<AlbumPaletteInput | null>;
}

/**
 * Extract the curatorId from a `curator:(album|card):<id>` URI, or null if it isn't one. Conductor
 * treats a card the same as a sleeve — both light up the room — so it only wants the id and ignores
 * the kind (ADR 0023). Delegates to the shared contracts parser so the accepted shape stays uniform.
 */
export function curatorIdFromUri(uri: string): string | null {
  return parseCuratorUri(uri)?.curatorId ?? null;
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
