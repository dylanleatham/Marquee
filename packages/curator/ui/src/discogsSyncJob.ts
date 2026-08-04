// The running Discogs collection sweep, tracked app-wide (issue #234).
//
// Same machinery as the palette sweep — see `libraryJob.ts`. It matters more here: a first sync of a
// real collection is minutes of paging and then hours of Roadie, and nobody is going to sit on the
// Add album screen watching it. Start it, walk away, and the panel is still there.
import { api } from "./api";
import { createLibraryJobStore, type LibraryJobState } from "./libraryJob";

const store = createLibraryJobStore("discogsSync", () => api.syncDiscogs());

/**
 * Sweep the collection, or reattach to a sweep already running. This is both the first big import
 * and every later "did I add anything on Discogs?" check — the server dedups on the release id, so
 * a re-run only adds what's new.
 */
export const startDiscogsSync = (): Promise<void> => store.start();

/** Reattach on mount, so a reload doesn't lose sight of a sweep that's still going. */
export const attachRunningDiscogsSync = (): Promise<void> =>
  store.attachRunning();

/** Stop the sweep. Albums already added stay added and stay queued with Roadie. */
export const cancelDiscogsSync = (): Promise<void> => store.cancel();

export const dismissDiscogsSync = (): void => store.dismiss();

/** Test seam: drop all state and stop the timer between cases. */
export const resetDiscogsSyncJob = (): void => store.reset();

export const useDiscogsSyncJob = (): LibraryJobState => store.use();
