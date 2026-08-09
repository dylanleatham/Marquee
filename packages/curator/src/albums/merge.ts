// Fold one copy of a record into another and drop the twin (issue #279).
//
// The library holds eighteen records twice, because the first Discogs sweep could not see albums
// added from Spotify — they carry no release id to match on
// ([ADR 0064](../../../../docs/adrs/0064-the-sweep-reports-a-record-it-already-owns.md)). ADR 0064
// deliberately stops the sweep creating more; it does not clean up what already exists, because
// choosing which copy survives is the owner's call and not a sweep's.
//
// **Deleting the bare twin is not enough, and doing only that is a trap.** The Discogs copy is the
// one holding the release id. Delete it and the survivor has none, so the next sweep sees an
// unmatched release and adds it straight back — the cleanup quietly undoes itself. The identity has
// to move across first. That is the whole reason this is a merge and not a delete.
import type { AlbumAsset } from "./asset.js";

/** What the survivor would gain, and anything that makes the merge unsafe to run. */
export interface MergePlan {
  /** Metadata fields to copy onto the survivor. Empty when it already has everything. */
  adopt: {
    discogsUri?: string;
    discogsReleaseId?: number;
    discogsArtUrl?: string;
  };
  /**
   * Reasons the merge must not proceed. Non-empty means refuse — these are all cases where going
   * ahead would destroy something a human cannot get back by re-running anything.
   */
  blockers: string[];
}

/**
 * Work out what merging `absorbed` into `survivor` would do, without doing any of it.
 *
 * Pure, and separated from the route because the interesting part is the refusals: this decides
 * when *not* to touch a collection, and that judgement deserves to be readable and testable on its
 * own.
 *
 * **It never overwrites.** The survivor's own values always win; the absorbed copy only fills gaps.
 * The owner picked the survivor precisely because its metadata is the one they trust, and a merge
 * that quietly replaced a field would be the app deciding something it was told not to decide.
 */
export function planMerge(
  survivor: AlbumAsset,
  absorbed: AlbumAsset,
): MergePlan {
  const blockers: string[] = [];

  if (survivor.curatorId === absorbed.curatorId)
    blockers.push("an album cannot be merged into itself");

  // The expensive artifact. A visualizer is minutes of generation and hundreds of megabytes, and
  // nothing else in the app can reconstruct it — so a merge that would delete the only copy is
  // refused outright rather than reported afterwards.
  if (absorbed.visualizer && !survivor.visualizer)
    blockers.push(
      `${absorbed.curatorId} holds the only visualizer — merge the other way, or attach it to ${survivor.curatorId} first`,
    );

  // Two different Discogs releases is not a duplicate to tidy; it is either two pressings the owner
  // deliberately has, or a mis-selected survivor. Either way the app must not pick one identity over
  // the other on its own (ADR 0064).
  const a = survivor.metadata.discogsUri;
  const b = absorbed.metadata.discogsUri;
  if (a && b && a !== b)
    blockers.push(
      `both copies carry a Discogs identity (${a} and ${b}) — they are different releases, not one record twice`,
    );

  const adopt: MergePlan["adopt"] = {};
  if (!a && b) {
    adopt.discogsUri = b;
    if (absorbed.metadata.discogsReleaseId !== undefined)
      adopt.discogsReleaseId = absorbed.metadata.discogsReleaseId;
    if (absorbed.metadata.discogsArtUrl && !survivor.metadata.discogsArtUrl)
      adopt.discogsArtUrl = absorbed.metadata.discogsArtUrl;
  }

  return { adopt, blockers };
}
