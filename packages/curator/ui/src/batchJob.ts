// The running palette sweep, tracked app-wide (curator-spec §10 "Batch progress", issue #104).
//
// All the machinery — polling, backoff, the "lost contact" signal, surviving navigation — lives in
// `libraryJob.ts`, shared with the Discogs collection sync (issue #234). This module is the palette
// sweep's binding of it, and keeps the names the rest of the app already calls.
//
// Progress arrives by polling `GET /api/jobs/:id`, not SSE — see ADR 0029.
import { api } from "./api";
import { createLibraryJobStore, type LibraryJobState } from "./libraryJob";

export { POLL_MS, MAX_POLL_MS, pollDelay } from "./libraryJob";

let force = false;
const store = createLibraryJobStore("paletteBatch", () =>
  api.regeneratePalettes(force),
);

/** Start a palette sweep, or reattach to the one already running (the server dedups — ADR 0029). */
export async function startPaletteRegen(
  forceHandEdited = false,
): Promise<void> {
  force = forceHandEdited;
  await store.start();
}

/**
 * Reattach to a sweep that was already running — called once when the app mounts, so a reload (or
 * opening the window after starting a sweep) picks the panel back up instead of leaving it invisible.
 */
export const attachRunningBatch = (): Promise<void> => store.attachRunning();

/** Cancel the sweep. The palettes already written stay written — only the remaining work stops. */
export const cancelBatch = (): Promise<void> => store.cancel();

/** Close the panel. Only ever user-driven or on a finished job — never while work is in flight. */
export const dismissBatch = (): void => store.dismiss();

/** Test seam: drop all state and stop the timer between cases. */
export const resetBatchJob = (): void => store.reset();

export const useBatchJob = (): LibraryJobState => store.use();
