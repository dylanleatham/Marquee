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
import { replaceIssuesFrom } from "../sync-issues.js";
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
   * Which transfer this is, for reporting. `resyncAll`'s response says what it actually did, and
   * "nothing, because transfer is off" has to be distinguishable from "uploaded everything" —
   * `{"pushed":12}` was identical in both cases (issue #187).
   */
  readonly mode: "local" | "push";
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
    mode: "local",
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
    mode: "push",
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
   * and upsert the entry; no video → upsert a `usesDefault` entry so the record still plays
   * something (ADR 0073). Records the outcome as the album's syncIssues so a failure surfaces in the
   * UI without blocking the human action that triggered it.
   *
   * A detach therefore *rewrites* the entry rather than removing it. Removal is reserved for the
   * album ceasing to exist (delete, merge) — see `removeAlbum`.
   */
  async syncAlbum(asset: AlbumAsset): Promise<SyncResult> {
    const baseEntry = buildLibraryEntry(asset, this.backdropMediaDir);
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
      this.recordSyncIssues(asset.curatorId, [`sync failed: ${message}`]);
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
    try {
      await this.client.updateEntry(entry);
      this.recordSyncIssues(asset.curatorId, []);
      this.log.info(
        `Backdrop: entry synced ${entry.uri} → ${entry.filePath ?? "the default visualizer"}`,
      );
      // Nothing to transfer for a record with no visualizer of its own — the default clip is
      // Backdrop's own file, not this album's, and is put there once by the operator.
      return {
        ok: true,
        transferNeeded: Boolean(this.mediaTransfer && asset.visualizer),
      };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`Backdrop sync failed for ${asset.curatorId}: ${message}`);
      this.recordSyncIssues(asset.curatorId, [`sync failed: ${message}`]);
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
    if (!this.mediaTransfer || !asset.visualizer)
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

      // A cancellation is not a failure, and must not leave one written on the album. Two things
      // cancel: the user pressing Stop, and a newer attach superseding this transfer — in the second
      // case a replacement is already running, so a "transfer failed" syncIssue would be actively
      // wrong, sitting on the album while the real transfer succeeds behind it. Existing issues are
      // left untouched: this attempt learned nothing about them either way.
      if (ctx.signal?.aborted) {
        this.log.info(
          `Backdrop: media transfer for ${asset.curatorId} cancelled`,
        );
        return { ok: false, skipped: true, error: "cancelled" };
      }

      this.log.warn(
        `Backdrop media transfer failed for ${asset.curatorId}: ${message}`,
      );
      this.recordSyncIssues(asset.curatorId, [
        `media transfer failed: ${message}`,
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
      this.recordSyncIssues(curatorId, [`sync failed: ${message}`]);
      return { ok: false, error: message };
    }
  }

  /**
   * Full reconcile (curator-spec §9 "run sync from Curator" recovery): push every album with a
   * visualizer as the complete library, transferring each file first. Returns per-album outcomes.
   */
  async resyncAll(
    assets: AlbumAsset[],
    ctx: {
      onProgress?: (done: number, total: number) => void;
      /**
       * The visualizer currently streaming, in **bytes**, or `null` when none is. A second callback
       * rather than a second meaning for `onProgress`: one channel carrying two units is what made a
       * running sync read `24248819/998` (issue #268), and the fix was to stop forwarding the album
       * counter into the transfer — not to start forwarding bytes back out of it.
       */
      onTransfer?: (
        transfer: { label: string; sent: number; total: number } | null,
      ) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    pushed: number;
    /** The active transfer mode, so "did this move my videos?" is answerable from the response. */
    mediaTransfer: "none" | "local" | "push";
    /** What happened to the *files*, as opposed to `pushed`, which counts library entries. */
    media: { transferred: number; unchanged: number; skipped: number };
    failures: Array<{ curatorId: string; error: string }>;
  }> {
    const entries: LibraryEntryWithUri[] = [];
    const failures: Array<{ curatorId: string; error: string }> = [];
    // Counted separately from `pushed` on purpose. `pushed` is library entries; these are bytes. A
    // response that conflated them reported a complete success having moved nothing (issue #187).
    let transferred = 0;
    let unchanged = 0;
    let skipped = 0;
    // Read the remote library once rather than per album: this is the path that walks the whole
    // library, and it is exactly where re-uploading everything would hurt most.
    const remote = this.mediaTransfer
      ? await this.client.getLibrary().catch(() => undefined)
      : undefined;

    ctx.onProgress?.(0, assets.length);
    for (const [i, asset] of assets.entries()) {
      // Between albums, not mid-file: a cancel stops the run promptly without corrupting the upload
      // in flight, which `putMedia`'s own signal handles.
      if (ctx.signal?.aborted) break;
      const baseEntry = buildLibraryEntry(asset, this.backdropMediaDir);
      // A record with no visualizer of its own still goes in the library, as `usesDefault`
      // (ADR 0073) — it just has no bytes to move, so it counts as neither transferred nor
      // unchanged. It used to be dropped from the reconcile entirely, which is why a `sync` could
      // report success and still leave the record unknown to Backdrop.
      if (!asset.visualizer) {
        entries.push(baseEntry);
        ctx.onProgress?.(i + 1, assets.length);
        continue;
      }
      try {
        const contentHash = this.mediaTransfer
          ? await this.hashVisualizer(asset)
          : undefined;
        const entry = contentHash ? { ...baseEntry, contentHash } : baseEntry;

        const isUnchanged =
          contentHash !== undefined &&
          remote?.entries[entry.uri]?.contentHash === contentHash;
        if (!this.mediaTransfer) {
          // Transfer is off (the default, ADR 0038): the entry goes, the file is someone else's job.
          skipped += 1;
        } else if (isUnchanged) {
          unchanged += 1;
          this.log.info(
            `Backdrop: ${entry.uri} already up to date, skipping upload`,
          );
        } else {
          const label = asset.metadata.name || asset.curatorId;
          try {
            await this.transferMedia(asset, entry.filePath, {
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              ...(ctx.onTransfer
                ? {
                    onBytes: (sent: number, total: number) =>
                      ctx.onTransfer?.({ label, sent, total }),
                  }
                : {}),
            });
          } finally {
            // Cleared however the upload ended. A failed transfer that left its last byte count on
            // screen would read as still running, which is the one thing this must never say.
            ctx.onTransfer?.(null);
          }
          transferred += 1;
        }
        entries.push(entry);
      } catch (err) {
        failures.push({
          curatorId: asset.curatorId,
          error: (err as Error).message,
        });
      }
      ctx.onProgress?.(i + 1, assets.length);
    }
    await this.client.syncAll(entries);
    return {
      pushed: entries.length,
      mediaTransfer: this.mediaTransferMode,
      media: { transferred, unchanged, skipped },
      failures,
    };
  }

  /** The active transfer mode — `none` when no strategy was supplied. Surfaced by `/api/backdrop/status`. */
  get mediaTransferMode(): "none" | "local" | "push" {
    return this.mediaTransfer?.mode ?? "none";
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
      const have = live.entries[entry.uri];
      if (!have) {
        discrepancies.push(`${entry.uri} not in the library`);
        continue;
      }
      // A record with no visualizer is in drift if Backdrop still holds a file for it — that is a
      // stale entry from before the detach, and Backdrop would keep playing the removed video
      // rather than the default (ADR 0073).
      if (entry.usesDefault) {
        if (have.filePath)
          discrepancies.push(
            `${entry.uri} has no visualizer, but the runtime still holds ${have.filePath}`,
          );
      } else if (have.filePath !== entry.filePath) {
        discrepancies.push(
          `${entry.uri} filePath drift: runtime has ${have.filePath ?? "the default visualizer"}, expected ${entry.filePath}`,
        );
      }
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
    _filePath: string | undefined,
    ctx: {
      signal?: AbortSignal;
      /**
       * Bytes sent / bytes total for this one file. Named `onBytes`, not `onProgress`, so it cannot
       * be confused with — or accidentally wired to — the album counter `resyncAll` reports on
       * (issue #268). The unit is in the name.
       */
      onBytes?: (sent: number, total: number) => void;
    } = {},
  ): Promise<void> {
    if (!this.mediaTransfer || !asset.visualizer) return; // off → rsync handles the file (Pi)
    const src = this.store.paths.visualizerFile(asset.visualizer.fileId);
    if (!existsSync(src))
      throw new Error(`local visualizer file missing at ${src}`);
    // The signal reaches `putMedia`, so cancelling a full resync aborts the upload in flight rather
    // than waiting out a transfer that can take ~90 minutes on the measured link (ADR 0038).
    //
    // Rebuild the context instead of forwarding `ctx`, and hand down the signal *only*. The
    // parameter type above already says `{ signal }`, but that is a claim about this function's
    // callers, not about what it passes on: `resyncAll` hands us its own ctx, whose `onProgress`
    // counts albums, while `copyVisualizer` reports bytes. Forwarding the object wholesale made one
    // callback carry both units, and a running sync reported `24248819/998` — bytes of the file in
    // flight against a total counted in album-legs ([#268](https://github.com/dylanleatham/Marquee/issues/268)).
    // A narrow parameter type does not strip the extra property at runtime; constructing the object
    // here is what actually enforces it.
    //
    // `onBytes` is wired to `copyVisualizer`'s byte-counting `onProgress` deliberately and by hand.
    // That is the only unit it has ever reported; what #268 forbade was letting the *album* counter
    // arrive here by inheritance, which is why the context is still rebuilt rather than forwarded.
    await this.mediaTransfer.copyVisualizer(src, asset.visualizer.fileId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onBytes ? { onProgress: ctx.onBytes } : {}),
    });
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

  /**
   * Replace **Backdrop's** syncIssues (re-reading first so a concurrent write isn't clobbered, #38).
   * Conductor writes the same field for the album-assets push, so this must not clear its entries —
   * see `replaceIssuesFrom`.
   */
  private recordSyncIssues(curatorId: string, issues: string[]): void {
    this.store.update(curatorId, (a) => {
      a.roadie.syncIssues = replaceIssuesFrom(
        a.roadie.syncIssues,
        "Backdrop",
        issues,
      );
      a.status = deriveStatus(a.roadie);
    });
  }
}

/** A no-op sync used when no Backdrop is configured, so routes call it unconditionally. */
export const disabledBackdropSync = {
  enabled: false as const,
  mediaTransferMode: "none" as const,
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
      mediaTransfer: "none" as const,
      media: { transferred: 0, unchanged: 0, skipped: 0 },
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
  | "mediaTransferMode"
> & { enabled: boolean };
