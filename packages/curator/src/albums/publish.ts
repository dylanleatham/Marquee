// The one place an album comes into existence. Every add path — manual, Spotify, Discogs, the
// collection sweep — ends here, so whatever has to happen when a record is born happens once.
import type { AssetStore } from "../store/asset-store.js";
import type { Roadie } from "../roadie/worker.js";
import type { AlbumAsset } from "./asset.js";

/**
 * What an add path needs to bring an album into being.
 *
 * `announce` is **required, not optional**, and that is the whole point
 * ([#343](https://github.com/dylanleatham/Marquee/issues/343)). Adding an album is a change to what
 * the room plays — under [ADR 0073](../../../../docs/adrs/0073-a-record-with-no-visualizer-plays-the-default.md)
 * every album Curator holds projects as a Backdrop entry, `usesDefault` until it has a visualizer of
 * its own. [ADR 0015](../../../../docs/adrs/0015-backdrop-sync-triggered-at-projection-changes.md)'s
 * trigger list starts at *video attach* because when it was written a video-less album projected as
 * `null` and there was nothing to push. ADR 0073 changed that premise and the list was never
 * widened, so every record added since the last full reconcile was unknown to Backdrop: it played
 * nothing and flashed `video not in library`, the mis-written-tag indicator, which is the exact
 * confusion ADR 0073 existed to remove.
 *
 * Making it a required field is what stops that recurring. A new add path cannot be written without
 * a `deps` to pass, and it cannot build one without deciding what announcing means — the compiler
 * asks the question that the trigger list stopped asking.
 */
export interface NewAlbumDeps {
  store: AssetStore;
  roadie: Roadie;
  /**
   * Tell the runtime this album now exists. Best-effort by contract (roadie-spec §6, ADR 0015 §3):
   * it records its own outcome as the album's `syncIssues` and must never throw, because a record
   * that reached the shelf must not be un-added by an unreachable Pi.
   */
  announce: (asset: AlbumAsset) => Promise<void>;
}

/**
 * Save a freshly built album, hand it to Roadie, and announce it to the runtime — in that order.
 *
 * Save first so the album survives a crash mid-announce; announce last so it describes something
 * that is actually on disk. Roadie sits between them because its queue is in-memory and instant,
 * and because the announce is the only step that touches the network.
 *
 * The announce is awaited rather than left floating: Backdrop's entry is what makes the record
 * playable at all, it is one small POST to the local network, and a caller that gets its 201 back
 * has been told the truth about the record being resolvable.
 *
 * Nothing is caught here. By the time `announce` runs the album is already saved and queued, so
 * turning a failed push into a thrown add would report "not added" for a record that *was* added and
 * invite a duplicate on retry. Containment therefore belongs to `announce` itself, which is why the
 * contract above says it must not throw and why `announceToRuntime` in `server.ts` — the one place
 * that builds it — is where that is made true.
 */
export async function publishNewAlbum(
  deps: NewAlbumDeps,
  asset: AlbumAsset,
): Promise<{ curatorId: string; asset: AlbumAsset }> {
  deps.store.save(asset);
  deps.roadie.enqueue(asset.curatorId);
  await deps.announce(asset);
  return { curatorId: asset.curatorId, asset };
}
