// The default visualizer on its way to Backdrop, tracked app-wide (ADR 0074).
//
// Same machinery as the palette, Discogs and Spotify sweeps — see `libraryJob.ts`. It is one file
// rather than a sweep, which does *not* make it quick: the link to a Pi has been measured at
// ~44 KB/s, where a few hundred megabytes is tens of minutes
// ([ADR 0038](../../../../docs/adrs/0038-curator-pushes-media-over-http.md)). A transfer that says
// nothing makes success and failure look identical, which is the bug the record page's Backdrop
// strip was built to fix; reusing this store is what stops it being reintroduced one screen over.
import { api } from "./api";
import { createLibraryJobStore, type LibraryJobState } from "./libraryJob";

const store = createLibraryJobStore("defaultVisualizerPush", () =>
  api.pushDefaultVisualizer(),
);

/** Send the clip Curator holds, or reattach to a send already going (the server dedups). */
export const startDefaultVisualizerPush = (): Promise<void> => store.start();

/**
 * Reattach on mount — and after an upload, which starts the push server-side without going through
 * `start()`. Without this the panel would show nothing for the whole of the transfer it just began.
 */
export const attachRunningDefaultVisualizerPush = (): Promise<void> =>
  store.attachRunning();

export const cancelDefaultVisualizerPush = (): Promise<void> => store.cancel();

export const dismissDefaultVisualizerPush = (): void => store.dismiss();

/** Test seam: drop all state and stop the timer between cases. */
export const resetDefaultVisualizerPushJob = (): void => store.reset();

export const useDefaultVisualizerPushJob = (): LibraryJobState => store.use();
