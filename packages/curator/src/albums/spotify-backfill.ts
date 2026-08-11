// Backfill the Spotify identity of Discogs-sourced albums (ADR 0059).
//
// Curator has been matching Discogs releases to Spotify since issue #58 — to borrow the cover — and
// discarding which album it matched. So a collection swept in from Discogs ends up with hundreds of
// albums that Curator *can* name on Spotify but whose `metadata.spotifyUri` is empty, and everything
// that streams audio (Amp on a card or demo scan, bench desk audio, the demo-track picker) correctly
// reports "not on Spotify" for records that plainly are.
//
// Fixing the onboarding step only helps albums added afterwards. This sweep re-runs the match for
// the ones already on disk, applying the identical rule via `applySpotifyMatch` — one definition of
// "good enough to play", used by both paths, because two would drift.
//
// Shaped after `regeneratePalettesRunner` (ADR 0029): a library-scoped job on the ADR 0018 manager,
// sequential, cancellable between albums, reporting per item.
import type { AssetStore } from "../store/asset-store.js";
import type { SpotifyClient } from "../spotify/client.js";
import { isProcessingState } from "./asset.js";
import { applySpotifyMatch, bestSpotifyMatch } from "./spotify-match.js";

/** The statuses the progress panel actually lists — the skips are filtered out before it renders. */
export type ReportedSpotifyBackfillStatus =
  "matched" | "art_only" | "no_match" | "ambiguous" | "failed";

export type SpotifyBackfillStatus =
  /** An `exact` match — the album can now play. */
  | "matched"
  /** A `close` match: the cover is recorded, but nothing may play from it. */
  | "art_only"
  /** Searched, nothing confident came back. Not a failure of the sweep. */
  | "no_match"
  /**
   * Several same-titled albums by the artist, none of them separable (ADR 0067 / #289). Reported
   * apart from `no_match` because the two imply opposite next steps: a miss may become a hit on the
   * next sweep, this one never will. Every re-run declines it again, so the row has to send the
   * reader to the record page rather than back to this button.
   */
  | "ambiguous"
  /** Already had a `spotifyUri` — nothing to do, and never overwritten. */
  | "skipped_has_uri"
  /** Not a Discogs album; a Spotify or manual add is not this sweep's business. */
  | "skipped_not_discogs"
  /** Roadie holds it mid-pipeline (ADR 0025) — it will get its match from the step itself. */
  | "skipped_processing"
  | "failed";

export interface SpotifyBackfillOutcome {
  curatorId: string;
  label: string;
  status: SpotifyBackfillStatus;
  /** What Spotify was matched to, for `matched`/`art_only` — so a wrong guess is reviewable. */
  matchedTo?: string;
  error?: string;
}

export interface SpotifyBackfillReport {
  total: number;
  matched: number;
  artOnly: number;
  noMatch: number;
  /** Refused as un-tellable-apart (#289). Counted apart from `noMatch` — re-running won't move it. */
  ambiguous: number;
  skipped: number;
  failed: number;
  /** True when the sweep stopped early on a run of failures — see CONSECUTIVE_FAILURE_LIMIT. */
  abandoned?: boolean;
  items: SpotifyBackfillOutcome[];
}

const label = (name: string, artist: string, curatorId: string): string =>
  name && artist ? `${artist} — ${name}` : (name ?? curatorId);

/**
 * Stop after this many failures in a row. One album failing is data; four hundred failing is Spotify
 * rate-limiting or a dead token, and grinding through the rest of the library to discover that
 * wastes several hundred requests and minutes. The sweep reports `abandoned` so the count isn't
 * mistaken for a clean run.
 */
const CONSECUTIVE_FAILURE_LIMIT = 10;

export function spotifyBackfillRunner(deps: {
  store: AssetStore;
  spotify: SpotifyClient;
  now?: () => string;
  logger?: { info(m: string): void; warn(m: string): void };
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (ctx: {
    onProgress: (done: number, total: number) => void;
    signal: AbortSignal;
  }): Promise<{ spotifyBackfill: SpotifyBackfillReport }> => {
    const albums = deps.store.list();
    const report: SpotifyBackfillReport = {
      total: albums.length,
      matched: 0,
      artOnly: 0,
      noMatch: 0,
      ambiguous: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
    ctx.onProgress(0, albums.length);

    let done = 0;
    let consecutiveFailures = 0;

    for (const asset of albums) {
      if (ctx.signal.aborted) break;
      const { curatorId, metadata } = asset;
      const record = (
        status: SpotifyBackfillStatus,
        extra: { matchedTo?: string; error?: string } = {},
      ) => {
        report.items.push({
          curatorId,
          label: label(metadata.name, metadata.artist, curatorId),
          status,
          ...extra,
        });
        if (status === "matched") report.matched++;
        else if (status === "art_only") report.artOnly++;
        else if (status === "no_match") report.noMatch++;
        else if (status === "ambiguous") report.ambiguous++;
        else if (status === "failed") report.failed++;
        else report.skipped++;
      };

      if (metadata.source !== "discogs") record("skipped_not_discogs");
      // Never overwrite an existing identity. A `spotifyUri` on disk was either a Spotify add or an
      // earlier exact match; re-deriving it could only downgrade a fact into a guess.
      else if (metadata.spotifyUri) record("skipped_has_uri");
      // A cheap pre-check against the snapshot, so the common case costs no Spotify call. It is not
      // the guard — `store.list()` was read once at the top, so an album can enter processing while
      // we are out on the network. The one that actually decides is inside the update below.
      else if (isProcessingState(asset.roadie.state))
        record("skipped_processing");
      else {
        try {
          const q = {
            artist: metadata.artist,
            title: metadata.name,
            ...(metadata.year !== undefined ? { year: metadata.year } : {}),
          };
          const candidates = await deps.spotify.searchAlbums(
            `${q.artist} ${q.title}`.trim(),
            10,
          );
          const outcome = bestSpotifyMatch(q, candidates);
          consecutiveFailures = 0;

          /**
           * Re-read under the store lock and re-decide there. This loop awaits the network per
           * album, so between the snapshot above and this write Roadie may have picked the album up
           * and be running its own match on it — the two would clobber each other, and the loser's
           * Spotify call was wasted. `store.update` gives a synchronous read-mutate-save, so
           * checking here is the check that counts (the asset-write race rule).
           *
           * One helper for **both** verdicts: an ambiguity is metadata too, and a second copy of
           * this guard is a second place for the race to be reintroduced when only one is edited.
           * Returns whether the write actually landed.
           */
          const applyUnderLock = (): boolean => {
            let applied = true;
            deps.store.update(curatorId, (fresh) => {
              if (
                isProcessingState(fresh.roadie.state) ||
                fresh.metadata.spotifyUri
              ) {
                applied = false;
                return;
              }
              fresh.metadata = applySpotifyMatch(fresh.metadata, outcome, now);
            });
            return applied;
          };

          if (outcome.kind === "none") record("no_match");
          else if (!applyUnderLock()) record("skipped_processing");
          else if (outcome.kind === "ambiguous")
            record("ambiguous", {
              matchedTo: `${outcome.candidates.length} albums share this title`,
            });
          else
            record(outcome.confidence === "exact" ? "matched" : "art_only", {
              matchedTo: `${outcome.album.artist} — ${outcome.album.name}`,
            });
        } catch (err) {
          // `instanceof` rather than the `(err as Error).message` used elsewhere in this package,
          // deliberately: this string is rendered to a human in the run report, and a non-Error
          // throw would put a bare `undefined` next to an album name with nothing to act on.
          const message = err instanceof Error ? err.message : String(err);
          record("failed", { error: message });
          if (++consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
            report.abandoned = true;
            deps.logger?.warn(
              `Spotify backfill abandoned after ${consecutiveFailures} consecutive failures: ${message}`,
            );
            ctx.onProgress(++done, albums.length);
            break;
          }
        }
      }
      ctx.onProgress(++done, albums.length);
    }

    deps.logger?.info(
      `Spotify backfill: ${report.matched} now playable, ${report.artOnly} art-only, ${report.noMatch} no match, ${report.ambiguous} ambiguous, ${report.failed} failed`,
    );
    return { spotifyBackfill: report };
  };
}
