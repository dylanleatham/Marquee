import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { LibraryEntry } from "@marquee/contracts";

/** On-disk shape of library.json (backdrop-spec §9). */
export interface LibraryFile {
  version: 1;
  updatedAt: string;
  entries: Record<string, LibraryEntry>;
}

const EMPTY: LibraryFile = { version: 1, updatedAt: "", entries: {} };

/**
 * Backdrop's URI → video-file map. Curator pushes updates via the sync API; the runtime resolves a
 * scan's `uri` to a `filePath` here. The whole thing is small (metadata only, no video bytes), so we
 * hold it in memory and rewrite the file atomically on every mutation.
 */
export class Library {
  private data: LibraryFile;
  private readonly path: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "library.json");
    this.data = this.read();
  }

  private read(): LibraryFile {
    if (!existsSync(this.path)) return { ...EMPTY, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LibraryFile;
      // Tolerate a hand-edited or partial file rather than crashing the runtime on boot.
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? "",
        entries: parsed.entries ?? {},
      };
    } catch {
      return { ...EMPTY, entries: {} };
    }
  }

  /** Write via temp-file + rename so a crash mid-write never leaves a truncated library.json. */
  private persist(): void {
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  /** The entry for a scan URI, or undefined if this album isn't in the library yet. */
  resolve(uri: string): LibraryEntry | undefined {
    return this.data.entries[uri];
  }

  /** Current map (read-only snapshot for GET /api/library). */
  all(): LibraryFile {
    return { ...this.data, entries: { ...this.data.entries } };
  }

  /** Full replace of the map (POST /api/library/sync). */
  replaceAll(entries: Record<string, LibraryEntry>): void {
    this.data.entries = { ...entries };
    this.persist();
  }

  /** Insert or update a single entry (POST /api/library/update). */
  upsert(uri: string, entry: LibraryEntry): void {
    this.data.entries[uri] = entry;
    this.persist();
  }

  /** Remove one entry (DELETE /api/library/:uri). Returns whether it existed. Does not touch files. */
  remove(uri: string): boolean {
    if (!(uri in this.data.entries)) return false;
    delete this.data.entries[uri];
    this.persist();
    return true;
  }
}
