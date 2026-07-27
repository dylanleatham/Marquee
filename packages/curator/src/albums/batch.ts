// Batch operations over the collection (curator-spec §8/§10, issue #104): adding a pasted list of
// albums in one call, and re-deriving every algorithmic palette after a Palette Press change.
//
// Both report **per item**. That is the whole point of doing them server-side: the UI already looped
// over lines firing one request each, which works but can only say "something failed" — it can't say
// "18 added, line 7 was already `2k7bxq9m`, line 12 isn't a URI." Neither operation aborts on a bad
// item; a single unreadable cover must not end a sweep of the library.
//
// The regeneration half runs as a library-scoped job on the ADR 0018 manager rather than the SSE
// stream the spec originally assumed — see ADR 0029.
import { existsSync } from "node:fs";
import type { AssetStore } from "../store/asset-store.js";
import type { Roadie } from "../roadie/worker.js";
import { isProcessingState } from "./asset.js";
import { ValidationError } from "./add-manual.js";
import {
  addSpotifyAlbum,
  DuplicateAlbumError,
  parseAlbumId,
} from "./add-spotify.js";
import { resolvedArtworkFile } from "./artwork.js";
import {
  regeneratePalette,
  PaletteConflictError,
  type ActionDeps,
} from "./actions.js";

// --- batch add ---------------------------------------------------------------------------------

/**
 * A hard cap on one request. Adds are cheap (no network on the request path) but the list comes
 * straight from a paste box, and an unbounded loop in an always-on service is the thing the working
 * agreement says to bound. 500 is far past any real paste and still answers instantly.
 */
export const MAX_BATCH_ADD = 500;

/** One entry: a bare `spotify:album:…` line, or the object form the spec documents. */
export type BatchAddItem =
  string | { mode?: string; spotifyUri?: string; spotifyId?: string };

export type BatchAddStatus = "added" | "duplicate" | "invalid" | "failed";

export interface BatchAddOutcome {
  /** Position in the submitted list, so the UI can point at the offending line. */
  index: number;
  /** What was submitted, echoed back — a report you can't map to your paste is useless. */
  input: string;
  status: BatchAddStatus;
  /** Set for `added`, and for `duplicate` (the id it already has). */
  curatorId?: string;
  error?: string;
}

export interface BatchAddReport {
  added: number;
  duplicate: number;
  invalid: number;
  failed: number;
  /** Ids of the albums actually created, in submission order (curator-spec §8's `curatorIds`). */
  curatorIds: string[];
  items: BatchAddOutcome[];
}

/** Render an item back as the text the user supplied, for the report. */
const describe = (item: BatchAddItem): string =>
  typeof item === "string"
    ? item
    : (item.spotifyUri ??
      (item.spotifyId
        ? `spotify:album:${item.spotifyId}`
        : JSON.stringify(item)));

const toInput = (
  item: BatchAddItem,
): { spotifyUri?: string; spotifyId?: string } =>
  typeof item === "string" ? { spotifyUri: item } : item;

/**
 * Add a list of Spotify albums, one outcome per item. Sequential and synchronous-ish: `addSpotifyAlbum`
 * dedups on the URI and hands off to Roadie without fetching, so the whole batch is local writes.
 *
 * Duplicates *within* the batch fall out for free — the first add is saved before the second is
 * checked, so the second reports `duplicate` against the id the first just got.
 *
 * Only the Spotify path is batched. Search needs a human to disambiguate results and manual entry
 * needs an artwork upload, so neither has a meaningful list form; curator-spec §8 is narrowed to match.
 */
export async function addAlbumsBatch(
  deps: { store: AssetStore; roadie: Roadie },
  items: BatchAddItem[],
): Promise<BatchAddReport> {
  if (!Array.isArray(items))
    throw new ValidationError("items must be an array");
  if (items.length === 0) throw new ValidationError("items must not be empty");
  if (items.length > MAX_BATCH_ADD)
    throw new ValidationError(
      `too many items (${items.length}) — the cap is ${MAX_BATCH_ADD} per request`,
    );

  const report: BatchAddReport = {
    added: 0,
    duplicate: 0,
    invalid: 0,
    failed: 0,
    curatorIds: [],
    items: [],
  };

  for (const [index, item] of items.entries()) {
    const input = describe(item);
    const record = (o: Omit<BatchAddOutcome, "index" | "input">) => {
      report.items.push({ index, input, ...o });
      report[o.status]++;
    };

    const parsed = toInput(item);
    if (!parseAlbumId(parsed)) {
      record({
        status: "invalid",
        error: "not a spotify:album:… URI or album id",
      });
      continue;
    }

    try {
      const { curatorId } = await addSpotifyAlbum(deps, parsed);
      report.curatorIds.push(curatorId);
      record({ status: "added", curatorId });
    } catch (err) {
      if (err instanceof DuplicateAlbumError)
        record({
          status: "duplicate",
          curatorId: err.curatorId,
          error: err.message,
        });
      else if (err instanceof ValidationError)
        record({ status: "invalid", error: err.message });
      else
        record({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
    }
  }
  return report;
}

// --- batch palette regeneration ----------------------------------------------------------------

export type BatchPaletteStatus =
  | "regenerated"
  | "skipped_hand_edited"
  | "skipped_processing"
  | "skipped_no_art"
  | "failed";

export interface BatchPaletteOutcome {
  curatorId: string;
  /** "Artist — Album", for a report you can read without cross-referencing ids. */
  label: string;
  status: BatchPaletteStatus;
  error?: string;
}

export interface BatchPaletteReport {
  total: number;
  regenerated: number;
  skipped: number;
  failed: number;
  items: BatchPaletteOutcome[];
}

const label = (name: string, artist: string, curatorId: string): string =>
  name || artist ? [artist, name].filter(Boolean).join(" — ") : curatorId;

/**
 * Re-derive every algorithmic palette in the collection — the "Palette Press v2 shipped, refresh the
 * library" path ([ADR 0033](../../../docs/adrs/0033-palette-derived-motion-energy.md) already changed
 * pattern selection once, and more palette-signal work is planned in issue #105).
 *
 * Three things are **skipped, not failed**, because none of them is a problem with the run:
 * hand-edited palettes (curator-spec §12 — never overwrite a hand-edit without user action; `force`
 * overrides), albums Roadie is mid-pipeline on (it holds the per-album lock, ADR 0025), and albums
 * with no cover art to extract from. Everything else that throws is recorded and the sweep continues.
 *
 * Sequential on purpose: extraction is CPU-bound local decoding, and fanning the collection out in
 * parallel would starve the event loop of an always-on service for no useful wall-clock gain. The
 * bound is cancellation, checked between albums — see ADR 0029.
 */
export function regeneratePalettesRunner(
  deps: ActionDeps,
  opts: { force?: boolean } = {},
) {
  return async (ctx: {
    onProgress: (done: number, total: number) => void;
    signal: AbortSignal;
  }): Promise<{ paletteBatch: BatchPaletteReport }> => {
    const albums = deps.store.list();
    const report: BatchPaletteReport = {
      total: albums.length,
      regenerated: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
    ctx.onProgress(0, albums.length);

    let done = 0;
    for (const asset of albums) {
      if (ctx.signal.aborted) break;
      const { curatorId } = asset;
      const record = (status: BatchPaletteStatus, error?: string) => {
        report.items.push({
          curatorId,
          label: label(asset.metadata.name, asset.metadata.artist, curatorId),
          status,
          ...(error ? { error } : {}),
        });
        if (status === "regenerated") report.regenerated++;
        else if (status === "failed") report.failed++;
        else report.skipped++;
      };

      // Pre-checks so each skip gets its own reason. `regeneratePalette` re-validates both under the
      // store lock, which is what actually makes it safe — this is only for the report.
      if (isProcessingState(asset.roadie.state)) record("skipped_processing");
      else if (asset.palette?.handEdited && !opts.force)
        record("skipped_hand_edited");
      else if (
        !asset.artwork ||
        !existsSync(resolvedArtworkFile(deps.store, asset))
      )
        record("skipped_no_art");
      else {
        try {
          await regeneratePalette(deps, curatorId, opts.force ?? false);
          record("regenerated");
        } catch (err) {
          // A conflict here means the album moved between the pre-check and the write — still a skip,
          // not a failure of the sweep.
          if (err instanceof PaletteConflictError)
            record("skipped_processing", err.message);
          else
            record("failed", err instanceof Error ? err.message : String(err));
        }
      }
      ctx.onProgress(++done, albums.length);
    }
    return { paletteBatch: report };
  };
}
