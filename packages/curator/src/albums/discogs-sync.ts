// Sync the whole Discogs collection into the library (issue #234). One sweep pages through the
// user's collection and hands every release Curator doesn't already have to Roadie, which fetches
// the release detail, downloads the cover, and derives the palette off the request path.
//
// The same sweep is the *first* sync and every later refresh: dedupe is on the Discogs release id,
// so a second run adds only what's new. There is no separate "initial import" path to keep correct,
// and no cursor to get out of step with reality — the collection itself is the state.
//
// **No LLM work is triggered, ever.** Roadie's pipeline ends at `awaiting_review`
// ([ADR 0027](../../../../docs/adrs/0027-generation-is-invoked-not-pipelined.md) took prompt drafting
// out of it), so a sweep of a thousand records spends zero Gemini credits. Anything that does cost
// credits — prompt drafting, card art, video — stays a per-album action the user takes deliberately.
//
// Runs as a library-scoped job on the
// [ADR 0018](../../../../docs/adrs/0018-generation-runs-as-background-jobs.md) manager, the same
// shape as the batch palette sweep
// ([ADR 0029](../../../../docs/adrs/0029-batch-work-runs-as-a-library-job.md)): the work is
// minutes-to-hours of Roadie time and must not sit on an HTTP request.
import type { AssetStore } from "../store/asset-store.js";
import type { Roadie } from "../roadie/worker.js";
import type {
  DiscogsClient,
  DiscogsCollectionItem,
} from "../discogs/client.js";
import { DiscogsError, discogsUri } from "../discogs/client.js";
import { backoffDelay, realSleep } from "../roadie/backoff.js";
import { DuplicateAlbumError } from "./add-spotify.js";
import {
  addDiscogsAlbum,
  albumKey,
  buildAlbumIndexes,
  type DiscogsIndex,
} from "./add-discogs.js";

/**
 * A hard cap on pages walked in one sweep — the working agreement's "unbounded loop over external
 * state gets a cap". At the Discogs maximum of 100 rows per page this is 20,000 records, far past any
 * real collection; a sweep that hits it reports `truncated` rather than looping on a paginator that
 * never says it's done.
 */
export const MAX_SYNC_PAGES = 200;

/** Rows per collection request. 100 is the Discogs ceiling — fewer requests against a 60/min budget. */
const PER_PAGE = 100;

/** How many times a failed *page* fetch is retried before the sweep gives up and reports partial. */
const PAGE_RETRIES = 3;

export type DiscogsSyncStatus =
  | "added"
  | "duplicate"
  /**
   * The library already holds this record, added by something other than this sweep — so the
   * release id it dedupes on was never there to match ([#279](https://github.com/dylanleatham/Marquee/issues/279)).
   *
   * Kept apart from `duplicate` because they mean different things to a human. `duplicate` is the
   * sweep working: the same release, already swept, nothing to do. A `collision` is a record you
   * own twice over, and it needs a decision the sweep is not entitled to make on its own.
   */
  | "collision"
  | "failed";

export interface DiscogsSyncOutcome {
  releaseId: number;
  /** "Artist — Title", so the report reads without cross-referencing release ids. */
  label: string;
  status: DiscogsSyncStatus;
  /** Set for `added`, and for `duplicate` (the id it already has). */
  curatorId?: string;
  error?: string;
}

export interface DiscogsSyncReport {
  /** What Discogs says is in the collection (its `pagination.items`). */
  total: number;
  /** Rows this sweep actually walked — below `total` when truncated or cancelled. */
  scanned: number;
  added: number;
  duplicate: number;
  /**
   * Records the library already had from another source, left untouched. The first full sweep
   * created 15 of these before this existed, and reported them as `added` — which is why the
   * duplicates went unnoticed for a day (#279).
   */
  collision: number;
  failed: number;
  /** Collection pages fetched. */
  pages: number;
  /**
   * The sweep stopped before the end of the collection — cancelled, page cap hit, or a page fetch
   * that kept failing. Whatever was added before that point is real and already queued; the next run
   * picks up the rest, since dedupe makes the sweep resumable by construction.
   */
  truncated: boolean;
  /** Why it stopped, when `truncated`. */
  truncatedReason?: "cancelled" | "page_cap" | "fetch_failed";
  /** Ids of the albums actually created, in collection order. */
  curatorIds: string[];
  items: DiscogsSyncOutcome[];
}

/**
 * What the sweep needs to say out loud. Named rather than inlined, matching `StepLogger` /
 * `RoadieLogger` and the Conductor and Backdrop sync loggers; `RoadieLogger` satisfies it
 * structurally, so the server passes its own straight through.
 */
export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface DiscogsSyncDeps {
  store: AssetStore;
  roadie: Roadie;
  discogs: DiscogsClient;
  /** Resolves the collection owner — configured username, else the token's identity. */
  resolveUsername: () => Promise<string>;
  logger?: SyncLogger;
  /** Injectable so tests run the retry path without real time. */
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const label = (item: DiscogsCollectionItem): string =>
  [item.artist, item.title].filter(Boolean).join(" — ") ||
  `release ${item.releaseId}`;

/** A page fetch is worth retrying when it's a rate limit, a timeout, or a server-side blip. */
const retryablePage = (err: unknown): boolean =>
  err instanceof DiscogsError &&
  (err.status === undefined || err.status === 429 || err.status >= 500);

/**
 * Build the runner for one full-collection sweep. Returns the `JobRunner` shape the
 * [ADR 0018](../../../../docs/adrs/0018-generation-runs-as-background-jobs.md) manager
 * drives, so the route is `jobs.start("discogsSync", undefined, runner)` and the manager's existing
 * dedupe means a second press (or a poll tick landing mid-sweep) reattaches instead of walking the
 * collection twice.
 *
 * Sequential on purpose. Adds are local writes, but each page is a Discogs API call against a 60/min
 * budget, and the albums land in Roadie's single-threaded queue anyway — fanning out would buy no
 * wall-clock and would spend the rate limit that Roadie's own fetches need.
 */
export function discogsSyncRunner(deps: DiscogsSyncDeps) {
  const sleep = deps.sleep ?? realSleep;
  return async (ctx: {
    onProgress: (done: number, total: number) => void;
    signal: AbortSignal;
  }): Promise<{ discogsSync: DiscogsSyncReport }> => {
    const report: DiscogsSyncReport = {
      total: 0,
      scanned: 0,
      added: 0,
      duplicate: 0,
      collision: 0,
      failed: 0,
      pages: 0,
      truncated: false,
      curatorIds: [],
      items: [],
    };

    const stop = (
      reason: NonNullable<DiscogsSyncReport["truncatedReason"]>,
    ) => {
      report.truncated = true;
      report.truncatedReason = reason;
    };

    const username = await deps.resolveUsername();
    // One pass over the store per page; every dedupe check in between is a map lookup, and each add
    // updates it — so a release listed twice in the collection is caught without re-reading disk.
    //
    // Refreshed each page rather than taken once, because this sweep runs for minutes and the store
    // has other writers: the per-row "Send to Roadie" button dedupes against a fresh scan, not this
    // map, so a record added by hand mid-sweep is invisible to a snapshot from the start and would
    // be added a second time under the same `discogsUri`. One extra pass per 100 records is cheap
    // (five for a 500-record collection) and bounds that window to a single page.
    //
    // Not a store-owned shared index: that would have to be invalidated by every writer, including
    // deletes, and an index that wrongly remembers a deleted album reports a real add as a duplicate
    // — a worse failure than the one it fixes. A cache that rebuilds on a known cadence can only be
    // stale, never wrong for long.
    /**
     * `index` keys on the Discogs release id; `byAlbum` keys on the record itself. Both come from
     * one pass, and both are refreshed each page for the reason above.
     *
     * `byAlbum` exists because release-id dedupe cannot see an album that arrived from Spotify — it
     * has no release id — so all fifteen of those fell through and were added a second time
     * ([#279](https://github.com/dylanleatham/Marquee/issues/279)). It is also the only thing that
     * catches two pressings of one record inside a single sweep, whose release ids genuinely differ.
     */
    let { byUri: index, byAlbum } = buildAlbumIndexes(deps.store);

    let page = 1;
    let pages = 1;

    while (page <= pages) {
      if (ctx.signal.aborted) {
        stop("cancelled");
        break;
      }
      if (page > MAX_SYNC_PAGES) {
        stop("page_cap");
        deps.logger?.warn(
          `Discogs sync stopped at the ${MAX_SYNC_PAGES}-page cap (${report.scanned} of ${report.total} scanned)`,
        );
        break;
      }

      const fetched = await fetchPage(page);
      if (!fetched) {
        stop("fetch_failed");
        break;
      }

      report.pages++;
      report.total = fetched.total;
      pages = fetched.pages;
      // Pick up anything another writer added while the previous page was being processed.
      if (report.pages > 1)
        ({ byUri: index, byAlbum } = buildAlbumIndexes(deps.store));
      ctx.onProgress(report.scanned, report.total);

      for (const item of fetched.items) {
        if (ctx.signal.aborted) {
          stop("cancelled");
          break;
        }
        await addOne(item);
        report.scanned++;
        ctx.onProgress(report.scanned, report.total);
      }
      if (report.truncated) break;
      page++;
    }

    deps.logger?.info(
      `Discogs sync: ${report.added} added, ${report.duplicate} already here, ` +
        `${report.collision} already owned from elsewhere, ` +
        `${report.failed} failed (${report.scanned}/${report.total} scanned)`,
    );
    return { discogsSync: report };

    /** One collection page, retrying rate limits and blips; `null` once it's out of attempts. */
    async function fetchPage(n: number) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await deps.discogs.getCollection(username, {
            page: n,
            perPage: PER_PAGE,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= PAGE_RETRIES || !retryablePage(err)) {
            deps.logger?.warn(
              `Discogs sync gave up on page ${n}: ${message} — ${report.added} albums added so far are queued; re-run to continue`,
            );
            return null;
          }
          deps.logger?.warn(
            `Discogs sync retrying page ${n} (attempt ${attempt + 1}/${PAGE_RETRIES}): ${message}`,
          );
          await sleep(backoffDelay(attempt + 1, deps.rand));
        }
      }
    }

    /** Add one row, recording its outcome. Never throws — one bad release must not end the sweep. */
    async function addOne(item: DiscogsCollectionItem): Promise<void> {
      const record = (o: Omit<DiscogsSyncOutcome, "releaseId" | "label">) => {
        report.items.push({
          releaseId: item.releaseId,
          label: label(item),
          ...o,
        });
        report[o.status]++;
      };
      // Checked before the add, not caught after it: the point is that no second copy is created.
      // The existing record is left exactly as it is — the sweep reports the collision and moves on,
      // because choosing between two copies (which keeps the visualizer, which year is right) is a
      // decision the owner makes, not one a background job makes on their behalf.
      //
      // **Only when the release id is unknown.** The id is the precise, authoritative match: a
      // re-run of an unchanged collection must keep reading as `duplicate`, and letting the looser
      // title+artist check run first would relabel every one of those a `collision` — turning the
      // sweep's healthy no-op into a library full of imaginary conflicts.
      const key = albumKey(item.title, item.artist);
      const owned = index.get(discogsUri(item.releaseId))
        ? undefined
        : byAlbum.get(key);
      if (owned) {
        record({ status: "collision", curatorId: owned });
        return;
      }
      try {
        const { curatorId } = await addDiscogsAlbum(
          { store: deps.store, roadie: deps.roadie, index },
          {
            releaseId: item.releaseId,
            title: item.title,
            artist: item.artist,
            ...(item.year !== undefined ? { year: item.year } : {}),
            ...(item.genres.length ? { genres: item.genres } : {}),
            ...(item.coverImage ? { coverImage: item.coverImage } : {}),
          },
        );
        report.curatorIds.push(curatorId);
        // So the next row of this same sweep sees it. Two pressings of one record arrive as two
        // honest release ids, and this is the only thing standing between them.
        byAlbum.add(key, curatorId);
        record({ status: "added", curatorId });
      } catch (err) {
        if (err instanceof DuplicateAlbumError)
          record({ status: "duplicate", curatorId: err.curatorId });
        else
          record({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
      }
    }
  };
}
