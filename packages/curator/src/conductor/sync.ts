// Curator → Conductor synchronization of the album-assets store (ADR 0045, runtime-overview §8).
//
// Conductor (and Amp, reading the same directory) resolves a scan by loading `{curatorId}.json` from
// its synced copy of Curator's store. That copy used to arrive only by a hand-run `rsync`, which is
// the leg that silently froze: the runtime sat six albums behind the workstation for days, answering
// every scan with `album not synced`, while Curator reported each album healthy.
//
// The deliberate shape here mirrors `backdrop/sync.ts`: sync is a **side effect, never a state
// change**. Every public method is best-effort, resolves with a result rather than throwing into its
// caller, and records what happened as the album's `syncIssues` so a failure is visible in the UI
// without blocking the human action that triggered it (roadie-spec §6).
import type { AssetStore } from "../store/asset-store.js";
import type { AlbumAsset } from "../albums/asset.js";
import { deriveStatus } from "../albums/asset.js";
import { replaceIssuesFrom } from "../sync-issues.js";
import { ConductorClient } from "./client.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const noopLogger: Logger = { info: () => {}, warn: () => {} };

export interface ConductorSyncOptions {
  store: AssetStore;
  /**
   * Every host that reads the album-assets store, in push order (ADR 0079). More than one is the
   * normal case on a mixed deployment — a desktop shell's own Conductor plus the runtime Pi, where
   * Amp reads the directory Conductor writes.
   */
  clients: ConductorClient[];
  logger?: Logger;
}

export interface SyncResult {
  ok: boolean;
  /** Set when sync was skipped (no Conductor push configured) — the caller can ignore it. */
  skipped?: boolean;
  error?: string;
  /** Which target took it and which did not, in push order (ADR 0079). Absent when skipped. */
  targets?: Array<{ url: string; ok: boolean }>;
}

/** One target's share of a whole-library resync — what makes `pushed` checkable rather than reassuring. */
export interface TargetSyncResult {
  url: string;
  pushed: number;
  failed: number;
}

/** One target's share of a drift check. `error` means we could not ask, which is not the same as drift. */
export interface TargetVerifyResult {
  url: string;
  ok: boolean;
  missing: string[];
  extra: string[];
  error?: string;
}

/**
 * Drives the album-assets push for one album and for the whole store.
 *
 * Unlike Backdrop's sync there is no projection step: the whole asset goes. Conductor reads a
 * palette slice and Amp reads a Spotify slice from the same file, so narrowing here would mean
 * choosing for both — and an identical file on both ends is what makes "is the runtime up to date"
 * answerable by comparing ids.
 */
export class ConductorSync {
  private readonly store: AssetStore;
  private readonly clients: ConductorClient[];
  private readonly log: Logger;

  constructor(opts: ConductorSyncOptions) {
    this.store = opts.store;
    this.clients = opts.clients;
    this.log = opts.logger ?? noopLogger;
  }

  get enabled(): boolean {
    return this.clients.length > 0;
  }

  /** The hosts this pushes to, in order — the routes use the count for their progress arithmetic. */
  get targets(): string[] {
    return this.clients.map((c) => c.target);
  }

  /**
   * Push one album's asset to **every** target. Records the outcome as syncIssues; never throws.
   *
   * Every target is attempted even after one fails: the Pi being off must not cost the workstation
   * its copy, and one host's silence must not be mistaken for the whole runtime's
   * ([ADR 0079](../../../../docs/adrs/0079-the-asset-push-has-more-than-one-target.md)). Each issue names the host that failed — with two targets,
   * "push failed" alone sends you to the wrong machine as often as the right one.
   */
  async syncAlbum(asset: AlbumAsset): Promise<SyncResult> {
    const perTarget: Array<{ url: string; ok: boolean }> = [];
    const failures: string[] = [];
    for (const client of this.clients) {
      try {
        await client.putAsset(asset);
        perTarget.push({ url: client.target, ok: true });
        this.log.info(
          `Conductor: pushed asset ${asset.curatorId} to ${client.target}`,
        );
      } catch (err) {
        const message = (err as Error).message;
        perTarget.push({ url: client.target, ok: false });
        this.log.warn(
          `Conductor push failed for ${asset.curatorId} to ${client.target}: ${message}`,
        );
        failures.push(`push failed to ${client.target}: ${message}`);
      }
    }
    this.recordSyncIssues(asset.curatorId, failures);
    return {
      ok: failures.length === 0,
      targets: perTarget,
      ...(failures.length ? { error: failures.join("; ") } : {}),
    };
  }

  /**
   * Push every album, one call each. Reports per-album failures rather than aborting the run — one
   * unreachable album must not strand the other twelve.
   *
   * `onProgress` and `signal` are threaded through because this runs inside a job: the caller shows
   * progress and can cancel. A cancelled run stops between albums; the ones already pushed stay
   * pushed, which is fine because each PUT is idempotent.
   */
  async resyncAll(
    assets: AlbumAsset[],
    ctx: {
      onProgress?: (done: number, total: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{
    pushed: number;
    failures: Array<{ curatorId: string; error: string }>;
    targets: TargetSyncResult[];
  }> {
    const failures: Array<{ curatorId: string; error: string }> = [];
    /**
     * `pushed` counts albums that reached **every** target, so the number can never claim reach it
     * does not have — the whole of [#306](https://github.com/dylanleatham/Marquee/issues/306) was a
     * run answering `pushed: 478, failures: []` while a runtime got nothing. `targets` breaks the
     * same run down per host, which is what makes the total checkable.
     */
    let pushed = 0;
    const perTarget = new Map<string, TargetSyncResult>(
      this.targets.map((url) => [url, { url, pushed: 0, failed: 0 }]),
    );
    ctx.onProgress?.(0, assets.length);
    for (const [i, asset] of assets.entries()) {
      if (ctx.signal?.aborted) break;
      const res = await this.syncAlbum(asset);
      for (const t of res.targets ?? []) {
        const row = perTarget.get(t.url);
        if (row) t.ok ? (row.pushed += 1) : (row.failed += 1);
      }
      if (res.ok) pushed += 1;
      else
        failures.push({ curatorId: asset.curatorId, error: res.error ?? "" });
      ctx.onProgress?.(i + 1, assets.length);
    }
    return { pushed, failures, targets: [...perTarget.values()] };
  }

  /**
   * Compare Curator's store against what Conductor is holding. Read-only.
   *
   * Reports both directions. `missing` is the one that breaks playback — an album the runtime has
   * never seen, which is what the stale-rsync failure looked like. `extra` cannot break anything
   * (the push is additive by design, so a deleted album leaves its file behind), but it is worth
   * surfacing rather than hiding: it is the only signal that the two stores have diverged.
   */
  async verify(assets: AlbumAsset[]): Promise<{
    ok: boolean;
    missing: string[];
    extra: string[];
    targets: TargetVerifyResult[];
    /** Set when a target could not be asked at all — the "runtime unreachable" case, named. */
    error?: string;
  }> {
    const local = new Set(assets.map((a) => a.curatorId));
    const targets: TargetVerifyResult[] = [];
    for (const client of this.clients) {
      try {
        const remote = new Set(await client.listAssets());
        targets.push({
          url: client.target,
          ok: [...local].every((id) => remote.has(id)),
          missing: [...local].filter((id) => !remote.has(id)).sort(),
          extra: [...remote].filter((id) => !local.has(id)).sort(),
        });
      } catch (err) {
        /**
         * A host we could not ask is **not** a host that is missing albums. Folding the two together
         * would list the whole library as `missing` the moment the Pi is asleep, and send someone to
         * re-push a store that may be perfectly current.
         */
        targets.push({
          url: client.target,
          ok: false,
          missing: [],
          extra: [],
          error: (err as Error).message,
        });
      }
    }
    // The union across targets, because the claim the status page makes is "every record is
    // everywhere it should be" — an album on one runtime and not the other is not there yet.
    const union = (pick: (t: TargetVerifyResult) => string[]) =>
      [...new Set(targets.flatMap(pick))].sort();
    // Summarised at the top level too, naming the host: this is what the status page reads, and
    // "the runtime is unreachable" is only actionable when it says *which* one.
    const unreachable = targets.filter((t) => t.error);
    return {
      ok: targets.every((t) => t.ok),
      missing: union((t) => t.missing),
      extra: union((t) => t.extra),
      targets,
      ...(unreachable.length
        ? { error: unreachable.map((t) => `${t.url}: ${t.error}`).join("; ") }
        : {}),
    };
  }

  /**
   * Replace **Conductor's** syncIssues (re-reading first so a concurrent write isn't clobbered, #38).
   * Backdrop writes the same field, so this must not clear its entries — see `replaceIssuesFrom`.
   */
  private recordSyncIssues(curatorId: string, issues: string[]): void {
    this.store.update(curatorId, (a) => {
      a.roadie.syncIssues = replaceIssuesFrom(
        a.roadie.syncIssues,
        "Conductor",
        issues,
      );
      a.status = deriveStatus(a.roadie);
    });
  }
}

/** A no-op sync used when no Conductor push is configured, so routes call it unconditionally. */
export const disabledConductorSync = {
  enabled: false as const,
  targets: [] as string[],
  async syncAlbum(): Promise<SyncResult> {
    return { ok: true, skipped: true };
  },
  async resyncAll() {
    return {
      pushed: 0,
      failures: [] as Array<{ curatorId: string; error: string }>,
      targets: [] as TargetSyncResult[],
    };
  },
  async verify() {
    return {
      ok: true,
      missing: [] as string[],
      extra: [] as string[],
      targets: [] as TargetVerifyResult[],
    };
  },
};

/** Either a live sync or the disabled no-op — the type the routes depend on. */
export type ConductorSyncLike = Pick<
  ConductorSync,
  "syncAlbum" | "resyncAll" | "verify"
> & { enabled: boolean; targets: string[] };
