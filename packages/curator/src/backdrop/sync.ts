// Curator → Backdrop synchronization (roadie-spec §6, runtime-overview §8). Two responsibilities:
//   1. Metadata: push the URI → filePath projection to Backdrop's library.json over HTTP. This is
//      what lets Backdrop resolve a scan to a video — the core of build step 9.
//   2. Video file: get the mp4 onto Backdrop's media dir. On the Pi this is out-of-band rsync
//      (deferred to hardware); on a single workstation `syncMediaLocally` copies it in-process so
//      the whole loop — add album in Curator → it plays in Backdrop — runs on one machine.
//
// Sync is a *side effect*, never a state change: a failure is recorded on the album as a syncIssue
// (surfaced in the derived status) and the album never moves backward (roadie-spec §6). So every
// public method is best-effort and resolves with a result rather than throwing into its caller.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssetStore } from "../store/asset-store.js";
import type { AlbumAsset } from "../albums/asset.js";
import { deriveStatus } from "../albums/asset.js";
import { BackdropClient } from "./client.js";
import {
  albumUri,
  buildLibraryEntry,
  type LibraryEntryWithUri,
} from "./projection.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const noopLogger: Logger = { info: () => {}, warn: () => {} };

/** Moves the visualizer mp4 onto Backdrop's media dir. Injectable so tests don't touch a real FS. */
export interface MediaTransfer {
  /** Copy Curator's local `srcPath` to Backdrop's media dir as `{fileId}.mp4`. Throws on failure. */
  copyVisualizer(srcPath: string, fileId: string): Promise<void>;
}

/** A same-filesystem copy into `backdropMediaDir` — the single-workstation transfer (see header). */
export function localCopyTransfer(backdropMediaDir: string): MediaTransfer {
  return {
    async copyVisualizer(srcPath, fileId) {
      mkdirSync(backdropMediaDir, { recursive: true });
      copyFileSync(srcPath, join(backdropMediaDir, `${fileId}.mp4`));
    },
  };
}

export interface BackdropSyncOptions {
  store: AssetStore;
  client: BackdropClient;
  /** Where Backdrop reads videos from *on its host*; also the projection's filePath root. */
  backdropMediaDir: string;
  /** Copy the mp4 into `backdropMediaDir` in-process (single-machine). Off → rsync does it (Pi). */
  mediaTransfer?: MediaTransfer;
  logger?: Logger;
}

export interface SyncResult {
  ok: boolean;
  /** Set when sync was skipped (no Backdrop configured) — the caller can ignore it. */
  skipped?: boolean;
  error?: string;
}

/**
 * Drives the sync for one album (on video attach/detach) and the whole library (manual resync /
 * verify). Constructed only when a Backdrop is configured; when it isn't, callers use the
 * `disabledBackdropSync` no-op below so the routes don't need null checks.
 */
export class BackdropSync {
  private readonly store: AssetStore;
  private readonly client: BackdropClient;
  private readonly backdropMediaDir: string;
  private readonly mediaTransfer?: MediaTransfer;
  private readonly log: Logger;

  constructor(opts: BackdropSyncOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.backdropMediaDir = opts.backdropMediaDir;
    this.mediaTransfer = opts.mediaTransfer;
    this.log = opts.logger ?? noopLogger;
  }

  get enabled(): boolean {
    return true;
  }

  /**
   * Reconcile one album with Backdrop. Video attached → copy the file (if in-process transfer is on)
   * and upsert the entry; no video → remove any stale entry. Records the outcome as the album's
   * syncIssues so a failure surfaces in the UI without blocking the human action that triggered it.
   */
  async syncAlbum(asset: AlbumAsset): Promise<SyncResult> {
    const entry = buildLibraryEntry(asset, this.backdropMediaDir);
    if (!entry) return this.removeAlbum(asset.curatorId);
    try {
      await this.transferMedia(asset, entry.filePath);
      await this.client.updateEntry(entry);
      this.recordSyncIssues(asset.curatorId, []);
      this.log.info(`Backdrop: synced ${entry.uri} → ${entry.filePath}`);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`Backdrop sync failed for ${asset.curatorId}: ${message}`);
      this.recordSyncIssues(asset.curatorId, [
        `Backdrop sync failed: ${message}`,
      ]);
      return { ok: false, error: message };
    }
  }

  /** Drop an album from Backdrop's library (video detached, or album deleted). Best-effort. */
  async removeAlbum(curatorId: string): Promise<SyncResult> {
    try {
      await this.client.removeEntry(albumUri(curatorId));
      this.recordSyncIssues(curatorId, []);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`Backdrop remove failed for ${curatorId}: ${message}`);
      this.recordSyncIssues(curatorId, [`Backdrop sync failed: ${message}`]);
      return { ok: false, error: message };
    }
  }

  /**
   * Full reconcile (curator-spec §9 "run sync from Curator" recovery): push every album with a
   * visualizer as the complete library, transferring each file first. Returns per-album outcomes.
   */
  async resyncAll(assets: AlbumAsset[]): Promise<{
    pushed: number;
    failures: Array<{ curatorId: string; error: string }>;
  }> {
    const entries: LibraryEntryWithUri[] = [];
    const failures: Array<{ curatorId: string; error: string }> = [];
    for (const asset of assets) {
      const entry = buildLibraryEntry(asset, this.backdropMediaDir);
      if (!entry) continue;
      try {
        await this.transferMedia(asset, entry.filePath);
        entries.push(entry);
      } catch (err) {
        failures.push({
          curatorId: asset.curatorId,
          error: (err as Error).message,
        });
      }
    }
    await this.client.syncAll(entries);
    return { pushed: entries.length, failures };
  }

  /**
   * Compare Backdrop's live library against the projection we expect (roadie-spec §6 verify). Reports
   * URIs missing from Backdrop and filePath mismatches; does not mutate state. Used by the manual
   * verify endpoint and (once the verified-transition endpoint lands) the ★verify-on-verified trigger.
   */
  async verify(
    assets: AlbumAsset[],
  ): Promise<{ ok: boolean; discrepancies: string[] }> {
    const live = await this.client.getLibrary();
    const discrepancies: string[] = [];
    for (const asset of assets) {
      const entry = buildLibraryEntry(asset, this.backdropMediaDir);
      if (!entry) continue;
      const have = live.entries[entry.uri];
      if (!have) discrepancies.push(`${entry.uri} not in Backdrop library`);
      else if (have.filePath !== entry.filePath)
        discrepancies.push(
          `${entry.uri} filePath drift: Backdrop has ${have.filePath}, expected ${entry.filePath}`,
        );
    }
    return { ok: discrepancies.length === 0, discrepancies };
  }

  private async transferMedia(
    asset: AlbumAsset,
    _filePath: string,
  ): Promise<void> {
    if (!this.mediaTransfer || !asset.visualizer) return; // off → rsync handles the file (Pi)
    const src = this.store.paths.visualizerFile(asset.visualizer.fileId);
    if (!existsSync(src))
      throw new Error(`local visualizer file missing at ${src}`);
    await this.mediaTransfer.copyVisualizer(src, asset.visualizer.fileId);
  }

  /** Replace the album's syncIssues (re-reading first so a concurrent write isn't clobbered, #38). */
  private recordSyncIssues(curatorId: string, issues: string[]): void {
    this.store.update(curatorId, (a) => {
      a.roadie.syncIssues = issues;
      a.status = deriveStatus(a.roadie);
    });
  }
}

/** A no-op sync used when no Backdrop is configured, so routes call it unconditionally. */
export const disabledBackdropSync = {
  enabled: false as const,
  async syncAlbum(): Promise<SyncResult> {
    return { ok: true, skipped: true };
  },
  async removeAlbum(): Promise<SyncResult> {
    return { ok: true, skipped: true };
  },
  async resyncAll() {
    return {
      pushed: 0,
      failures: [] as Array<{ curatorId: string; error: string }>,
    };
  },
  async verify() {
    return { ok: true, discrepancies: [] as string[] };
  },
};

/** Either a live sync or the disabled no-op — the type the routes depend on. */
export type BackdropSyncLike = Pick<
  BackdropSync,
  "syncAlbum" | "removeAlbum" | "resyncAll" | "verify"
> & { enabled: boolean };
