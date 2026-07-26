// "Next album at this state" (issue #94) — the in-session flow affordance.
//
// album-onboarding-workflow §12 has called this first-class since it was written: after finishing an
// album the question is "am I in a flow?", and if you are, the next album at the same state should be
// one keystroke away rather than a return to the queue and a hunt for your place. Ten albums in a
// session is ten hunts.
//
// It lives here, server-side, for one reason: the peers must be *the queue's* neighbours, in the
// queue's order. Re-deriving that on the detail page would be a second implementation of the
// ordering, free to drift from the list you were just looking at.
import type { AlbumAsset, RoadieState } from "./asset.js";

/** The buckets the queue view renders, in the order it renders them (roadie-spec §11). */
export const QUEUE_BUCKETS = [
  "awaiting_review",
  "awaiting_video",
  "awaiting_preview",
  "awaiting_tag_write",
  "awaiting_verify",
  "processing",
  "errored",
  "needs_manual",
  "done_recently",
] as const;

export type QueueBucket = (typeof QUEUE_BUCKETS)[number];

/**
 * The bucket an album's state belongs to. Shared with `buildQueue` so a peer walk and the queue can
 * never disagree about which albums sit together — `verified` reads as "done recently", every
 * in-flight processing state collapses into one bucket, and the rest map by name.
 */
export function bucketFor(state: RoadieState): QueueBucket {
  if (state === "verified") return "done_recently";
  return (QUEUE_BUCKETS as readonly string[]).includes(state)
    ? (state as QueueBucket)
    : "processing";
}

/** Just enough of a neighbour to render a link to it. */
export interface Peer {
  curatorId: string;
  title: string;
}

export interface PeerContext {
  bucket: QueueBucket;
  /** 1-based, for "3 of 7" — a position nobody has to count to. */
  position: number;
  total: number;
  prev: Peer | null;
  next: Peer | null;
}

const peer = (a: AlbumAsset): Peer => ({
  curatorId: a.curatorId,
  title: a.metadata.name || a.curatorId,
});

/**
 * Where this album sits among its peers, and who is either side.
 *
 * **Deliberately does not wrap.** At the end of a run of tag writes the honest answer is "that was
 * the last one", and silently looping back to the first would make you re-verify an album you
 * already finished without noticing. The UI disables the control and says why (curator-ui-ux §10).
 *
 * Returns null for an unknown album.
 */
export function peerContext(
  albums: AlbumAsset[],
  curatorId: string,
): PeerContext | null {
  const self = albums.find((a) => a.curatorId === curatorId);
  if (!self) return null;
  const bucket = bucketFor(self.roadie.state);
  const siblings = albums.filter((a) => bucketFor(a.roadie.state) === bucket);
  const i = siblings.findIndex((a) => a.curatorId === curatorId);
  return {
    bucket,
    position: i + 1,
    total: siblings.length,
    prev: i > 0 ? peer(siblings[i - 1]!) : null,
    next: i < siblings.length - 1 ? peer(siblings[i + 1]!) : null,
  };
}
