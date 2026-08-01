// Read the synced album-assets store at scan time (issue #45 / ADR 0019). This is the first time
// Conductor reads Curator's store (runtime-overview §5: "Conductor reads the album-assets store");
// until now it only accepted pre-built payloads on /api/playback. Injectable so tests seed albums
// without touching disk.
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseCuratorUri, type AlbumPaletteInput } from "@marquee/contracts";

/** Reads one album's palette-relevant fields by curatorId, or null if absent/unreadable. */
export interface AlbumAssetReader {
  read(curatorId: string): Promise<AlbumPaletteInput | null>;
}

/**
 * Writes assets Curator pushes over HTTP (ADR 0045). Until then the store arrived only by a hand-run
 * `rsync`, which is exactly the leg that silently froze — leaving Conductor answering every scan with
 * `album not synced` while Curator reported the album healthy.
 */
export interface AlbumAssetWriter {
  /** Persist one album's asset JSON. Resolves with the bytes written. */
  write(curatorId: string, asset: unknown): Promise<number>;
  /** The curatorIds currently on disk — what Curator diffs against to report drift. */
  list(): Promise<string[]>;
}

/** The id shape both halves build paths from. Anything else is rejected before touching the disk. */
const CURATOR_ID = /^[a-z0-9]{8}$/;

/**
 * Extract the curatorId from a `curator:(album|card):<id>` URI, or null if it isn't one. Conductor
 * treats a card the same as a sleeve — both light up the room — so it only wants the id and ignores
 * the kind (ADR 0034). Delegates to the shared contracts parser so the accepted shape stays uniform.
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
    if (!CURATOR_ID.test(curatorId)) return null;
    try {
      const raw = await readFile(join(this.dir, `${curatorId}.json`), "utf8");
      return JSON.parse(raw) as AlbumPaletteInput;
    } catch {
      // ENOENT (not synced) or bad JSON — both degrade to "stay put".
      return null;
    }
  }
}

/**
 * Filesystem writer over the same `{albumAssetsDir}/{curatorId}.json` layout the reader serves.
 *
 * Writes go to a temp file and are then renamed, so a scan reading mid-write sees either the old
 * asset or the new one — never a half-written file that `JSON.parse` would reject and the reader
 * would silently degrade to "album not synced". The temp name carries a **per-write UUID** rather
 * than a fixed `.tmp` suffix: two pushes of the same album would otherwise share one temp path and
 * interleave. (Backdrop's `Library` can use a fixed name only because every write is serialised
 * through one in-memory object; there is no such chokepoint here.)
 *
 * Unlike the reader, failures are **not** swallowed — a push that cannot land must tell Curator so,
 * or the store drifts exactly the way the manual rsync did.
 */
export class FsAlbumAssetWriter implements AlbumAssetWriter {
  constructor(private readonly dir: string) {}

  async write(curatorId: string, asset: unknown): Promise<number> {
    if (!CURATOR_ID.test(curatorId))
      throw new Error(`not a curatorId: ${JSON.stringify(curatorId)}`);
    const body = `${JSON.stringify(asset, null, 2)}\n`;
    const tmp = join(this.dir, `.${curatorId}.${randomUUID()}.tmp`);
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(tmp, body, "utf8");
      await rename(tmp, join(this.dir, `${curatorId}.json`));
    } catch (err) {
      // Never leave a stray temp file behind on a failed push; the cleanup itself must not mask the
      // original error, which is the one that explains what went wrong.
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return Buffer.byteLength(body);
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      // Only a *missing* directory means "nothing synced yet" — it appears on the first push. Any
      // other fault (permissions, a bad mount, a failing card) must not read back as an empty store:
      // this list is the other half of Curator's drift report, so swallowing a real error would
      // report every album as missing and send the operator to re-push a runtime that can't write.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .filter((id) => CURATOR_ID.test(id))
      .sort();
  }
}
