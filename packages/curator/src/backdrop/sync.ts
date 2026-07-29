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
import { copyFileSync, existsSync, mkdirSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
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
  /**
   * Copy Curator's local `srcPath` to Backdrop's media dir as `{fileId}.mp4`. Throws on failure.
   *
   * `ctx` is optional throughout: a local copy has nothing useful to report and nothing to cancel,
   * so it ignores it. Only the HTTP push, which can take an hour over a bad link, uses it (#177).
   */
  copyVisualizer(
    srcPath: string,
    fileId: string,
    ctx?: {
      onProgress?: (sent: number, total: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<void>;
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

/**
 * Stream the file to Backdrop over HTTP — the split-deployment transfer (ADR 0038). This is the case
 * the runbook used to hand to a manual `rsync`, which meant an album could be fully prepared, synced,
 * reported healthy, and still have no video on the other end.
 *
 * A second implementation of the interface `localCopyTransfer` already satisfies; nothing in the
 * calling path changes.
 */
export function httpPushTransfer(client: BackdropClient): MediaTransfer {
  return {
    async copyVisualizer(srcPath, fileId, ctx) {
      await client.putMedia(fileId, srcPath, ctx ?? {});
    },
  };
}

/**
 * Which transfer a Backdrop config asks for. One rule, in one place, because the setting can arrive
 * two ways: the explicit `mediaTransfer` mode (ADR 0038) or the legacy `syncMediaLocally` boolean it
 * replaced. The explicit mode always wins; the boolean is the fallback, so an older config keeps its
 * behaviour instead of silently transferring nothing.
 */
export function effectiveMediaTransferMode(backdrop: {
  mediaTransfer?: "none" | "local" | "push";
  syncMediaLocally?: boolean;
}): "none" | "local" | "push" {
  return (
    backdrop.mediaTransfer ?? (backdrop.syncMediaLocally ? "local" : "none")
  );
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
    const baseEntry = buildLibraryEntry(asset, this.backdropMediaDir);
    if (!baseEntry) return this.removeAlbum(asset.curatorId);
    try {
      // Hash first: it decides both whether the upload can be skipped and what the entry advertises,
      // so the value Backdrop stores is always the one that was actually sent.
      const contentHash = this.mediaTransfer
        ? await this.hashVisualizer(asset)
        : undefined;
      const entry = contentHash ? { ...baseEntry, contentHash } : baseEntry;

      if (await this.remoteHasSameFile(entry.uri, contentHash)) {
        this.log.info(
          `Backdrop: ${entry.uri} already up to date, skipping upload`,
        );
      } else {
        await this.transferMedia(asset, entry.filePath);
      }
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

  /**
   * The metadata half of a sync, run on the request path (issue #177). Fast and small: it is what
   * makes the album resolvable at all, so it stays synchronous.
   *
   * **It deliberately publishes no `contentHash`.** The bytes have not moved yet. An entry that
   * advertised a hash for a file Backdrop does not have would make every future sync skip the
   * upload — permanently, silently — which is the exact failure ADR 0038 set out to remove. The hash
   * is written only by `transferMediaInBackground`, after the file has actually landed. Backdrop
   * tolerates an entry pointing at a file not yet present (backdrop-spec §10), so this intermediate
   * state is legal and already specified.
   *
   * Returns whether a file transfer is still owed, so the caller knows whether to start a job.
   */
  async syncMetadata(
    asset: AlbumAsset,
  ): Promise<SyncResult & { transferNeeded: boolean }> {
    const entry = buildLibraryEntry(asset, this.backdropMediaDir);
    if (!entry)
      return {
        ...(await this.removeAlbum(asset.curatorId)),
        transferNeeded: false,
      };
    try {
      await this.client.updateEntry(entry);
      this.recordSyncIssues(asset.curatorId, []);
      this.log.info(`Backdrop: entry synced ${entry.uri} → ${entry.filePath}`);
      return { ok: true, transferNeeded: Boolean(this.mediaTransfer) };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`Backdrop sync failed for ${asset.curatorId}: ${message}`);
      this.recordSyncIssues(asset.curatorId, [
        `Backdrop sync failed: ${message}`,
      ]);
      return { ok: false, error: message, transferNeeded: false };
    }
  }

  /**
   * The file half, driven by a background job so the request never waits on it (issue #177). Reports
   * bytes sent, honours cancellation, and only on success re-upserts the entry **with** the hash —
   * see `syncMetadata` for why that ordering is load-bearing.
   */
  async transferMediaInBackground(
    asset: AlbumAsset,
    ctx: {
      onProgress?: (sent: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<SyncResult> {
    const entry = buildLibraryEntry(asset, this.backdropMediaDir);
    if (!entry || !this.mediaTransfer || !asset.visualizer)
      return { ok: true, skipped: true };

    try {
      const contentHash = await this.hashVisualizer(asset);
      if (await this.remoteHasSameFile(entry.uri, contentHash)) {
        this.log.info(
          `Backdrop: ${entry.uri} already up to date, skipping upload`,
        );
      } else {
        const src = this.store.paths.visualizerFile(asset.visualizer.fileId);
        if (!existsSync(src))
          throw new Error(`local visualizer file missing at ${src}`);
        await this.mediaTransfer.copyVisualizer(
          src,
          asset.visualizer.fileId,
          ctx,
        );
      }
      // Only now that the bytes are there does the hash become true.
      if (contentHash) await this.client.updateEntry({ ...entry, contentHash });
      this.recordSyncIssues(asset.curatorId, []);
      this.log.info(`Backdrop: media transferred for ${entry.uri}`);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(
        `Backdrop media transfer failed for ${asset.curatorId}: ${message}`,
      );
      this.recordSyncIssues(asset.curatorId, [
        `Backdrop media transfer failed: ${message}`,
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
    // Read the remote library once rather than per album: this is the path that walks the whole
    // library, and it is exactly where re-uploading everything would hurt most.
    const remote = this.mediaTransfer
      ? await this.client.getLibrary().catch(() => undefined)
      : undefined;

    for (const asset of assets) {
      const baseEntry = buildLibraryEntry(asset, this.backdropMediaDir);
      if (!baseEntry) continue;
      try {
        const contentHash = this.mediaTransfer
          ? await this.hashVisualizer(asset)
          : undefined;
        const entry = contentHash ? { ...baseEntry, contentHash } : baseEntry;

        const unchanged =
          contentHash !== undefined &&
          remote?.entries[entry.uri]?.contentHash === contentHash;
        if (unchanged) {
          this.log.info(
            `Backdrop: ${entry.uri} already up to date, skipping upload`,
          );
        } else {
          await this.transferMedia(asset, entry.filePath);
        }
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

  /**
   * ★verify-on-`verified` (roadie-spec §6 / ADR 0015): confirm Backdrop actually carries this album
   * the moment it's marked verified, and surface any discrepancy as the album's syncIssues so it
   * shows in the UI — without blocking the verify action. The symmetric counterpart to `syncAlbum`.
   */
  async verifyAlbum(
    asset: AlbumAsset,
  ): Promise<{ ok: boolean; discrepancies: string[] }> {
    const check = await this.verify([asset]);
    this.recordSyncIssues(asset.curatorId, check.ok ? [] : check.discrepancies);
    return check;
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

  /**
   * The content hash of an album's visualizer, or undefined when there is nothing to hash.
   *
   * Measured at ~470 MB/s, so a 228 MB visualizer costs ~0.5s — against a transfer that took ~90
   * minutes over a real link to a Pi. That ratio is the entire argument for computing it every sync
   * rather than persisting it: recomputing is free next to re-uploading, and there is no stored value
   * to go stale or need backfilling for albums that predate this.
   */
  private async hashVisualizer(asset: AlbumAsset): Promise<string | undefined> {
    if (!asset.visualizer) return undefined;
    const src = this.store.paths.visualizerFile(asset.visualizer.fileId);
    if (!existsSync(src)) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(src)) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  }

  /**
   * Whether Backdrop already holds this exact file, so the upload can be skipped.
   *
   * Only ever answers true on a hash match. An entry without a `contentHash` — anything synced before
   * this, or moved by rsync — is treated as unknown and re-pushed: a needless upload is a cost, a
   * skipped one that was actually needed is a black screen.
   */
  private async remoteHasSameFile(
    uri: string,
    contentHash?: string,
  ): Promise<boolean> {
    if (!contentHash) return false;
    try {
      const library = await this.client.getLibrary();
      return library.entries[uri]?.contentHash === contentHash;
    } catch {
      return false; // can't tell → send it
    }
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
  async syncMetadata(): Promise<SyncResult & { transferNeeded: boolean }> {
    return { ok: true, skipped: true, transferNeeded: false };
  },
  async transferMediaInBackground(): Promise<SyncResult> {
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
  async verifyAlbum() {
    return { ok: true, discrepancies: [] as string[] };
  },
};

/** Either a live sync or the disabled no-op — the type the routes depend on. */
export type BackdropSyncLike = Pick<
  BackdropSync,
  | "syncAlbum"
  | "syncMetadata"
  | "transferMediaInBackground"
  | "removeAlbum"
  | "resyncAll"
  | "verify"
  | "verifyAlbum"
> & { enabled: boolean };
