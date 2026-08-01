// `roadie.syncIssues` is one flat list on the album, but more than one service writes to it: Backdrop
// (library projection + video bytes) and Conductor (the album-assets store, ADR 0045). Each writer
// replaces its own findings on every attempt — that is how an issue clears once the next sync
// succeeds — so a naive `syncIssues = issues` makes the two services erase each other, and whichever
// synced last would be the only one whose problems you ever saw.
//
// The fix is to namespace each entry by the service that raised it and replace only that slice.
// Kept as `string[]` on purpose: the field is rendered verbatim in the queue and album views, and a
// structured shape would mean migrating every asset file on disk for no gain the UI can use.

/** The services that can raise a sync issue against an album. */
export const SYNC_SOURCES = ["Backdrop", "Conductor"] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

/**
 * Whether `issue` was raised by `source`.
 *
 * Accepts the current `"Backdrop: …"` form and the older unpunctuated `"Backdrop sync failed: …"`
 * one that predates namespacing, so an album carrying issues written before this change still gets
 * them cleared by the next successful sync instead of keeping them forever.
 */
function isFrom(issue: string, source: SyncSource): boolean {
  return issue.startsWith(`${source}:`) || issue.startsWith(`${source} `);
}

/** Render one of `source`'s messages for storage. */
export function tagIssue(source: SyncSource, message: string): string {
  return `${source}: ${message}`;
}

/**
 * Replace `source`'s issues with `issues`, leaving every other service's entries untouched.
 * Pass an empty `issues` to clear them — what a successful sync does.
 */
export function replaceIssuesFrom(
  existing: readonly string[],
  source: SyncSource,
  issues: readonly string[],
): string[] {
  return [
    ...existing.filter((issue) => !isFrom(issue, source)),
    ...issues.map((message) => tagIssue(source, message)),
  ];
}
