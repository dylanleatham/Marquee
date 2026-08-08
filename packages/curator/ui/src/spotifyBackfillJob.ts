// The running Spotify-identity backfill, tracked app-wide (ADR 0059).
//
// Same machinery as the palette and Discogs sweeps — see `libraryJob.ts`. It is one Spotify search
// per unmatched album, so on a real Discogs-swept collection that is several hundred requests and a
// few minutes: exactly the shape that has to outlive the screen you started it from.
import { api } from "./api";
import { createLibraryJobStore, type LibraryJobState } from "./libraryJob";

const store = createLibraryJobStore("spotifyBackfill", () =>
  api.backfillSpotifyMatches(),
);

/**
 * Re-match every Discogs album that has no Spotify URI, or reattach to a run already going. Safe to
 * re-run: an album that already has a URI is skipped, never re-derived, and only an exact match sets
 * one — so a second pass can add albums but can never downgrade one.
 */
export const startSpotifyBackfill = (): Promise<void> => store.start();

/** Reattach on mount, so a reload doesn't lose sight of a run that's still going. */
export const attachRunningSpotifyBackfill = (): Promise<void> =>
  store.attachRunning();

/** Stop the run. Albums already matched keep their match — only the remaining work stops. */
export const cancelSpotifyBackfill = (): Promise<void> => store.cancel();

export const dismissSpotifyBackfill = (): void => store.dismiss();

/** Test seam: drop all state and stop the timer between cases. */
export const resetSpotifyBackfillJob = (): void => store.reset();

export const useSpotifyBackfillJob = (): LibraryJobState => store.use();
