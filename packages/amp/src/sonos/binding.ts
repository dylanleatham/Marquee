// Pure, hardware-independent Sonos helpers extracted from svrooij-driver.ts (which imports the whole
// @svrooij/sonos library) so the fragile, firmware-coupled bits — favorite-DIDL parsing, the sid/sn
// URI patch, room matching — are unit-tested without any hardware or heavy import (amp-spec §13).

/** The account-level Spotify values needed to build a playable container URI (never hardcoded). */
export interface SpotifyBinding {
  /** Service id from the favorite's container URI, e.g. "12". */
  sid: string;
  /** Account serial from the favorite's container URI, e.g. "1". */
  sn: string;
  /** The cdudn token, e.g. "SA_RINCON3079_X_#Svc3079-0-Token". */
  token: string;
}

/**
 * Extract the Spotify `sid`/`sn`/`cdudn` token from a Favorites DIDL string (as returned by
 * ContentDirectoryService.Browse of `FV:2`, XML-escaped). Returns `null` when there is no Spotify
 * album favorite to read them from — the caller degrades to "ignored". The values are account-level
 * and reusable across every album.
 */
export function parseFavoriteBinding(didl: string): SpotifyBinding | null {
  // The Spotify favorite's <res> is an x-rincon-cpcontainer with sid + sn in its query.
  const res = didl.match(
    /x-rincon-cpcontainer:1004206c[^"<]*?sid=(\d+)[^"<]*?sn=(\d+)/,
  );
  if (!res) return null;
  // The account cdudn token lives in that same item's resMD, just after the res.
  const token = didl
    .slice(res.index ?? 0)
    .match(/SA_RINCON\d+_X_#Svc\d+-0-Token/)?.[0];
  if (!token) return null;
  return { sid: res[1] as string, sn: res[2] as string, token };
}

/** The Sonos service region encoded in the cdudn token (e.g. "3079"), for MetaDataHelper. US default. */
export function regionFromToken(token: string): string {
  return token.match(/SA_RINCON(\d+)_/)?.[1] ?? "3079";
}

/**
 * Patch the library's guessed container URI to carry this household's real `sid`/`sn`. `@svrooij/sonos`
 * hardcodes `sid=9`/`sn=7`, which a live account rejects with UPnP 800 — the derived binding is right.
 * Replaces only the query params, leaving the rest of the URI (the `spotify:album` container id) intact.
 */
export function patchContainerUri(
  guessedTrackUri: string,
  binding: SpotifyBinding,
): string {
  return guessedTrackUri
    .replace(/([?&])sid=\d+/, `$1sid=${binding.sid}`)
    .replace(/([?&])sn=\d+/, `$1sn=${binding.sn}`);
}

/** The subset of a Sonos device the room matcher needs (a SonosDevice is a structural superset). */
export interface RoomLike {
  Name: string;
  GroupName?: string;
}

/**
 * Find the device whose room the `target` names: an exact room-name match first, then a device in a
 * group whose name contains the target (a joined group is named e.g. "Kitchen + 1"). Case-insensitive.
 * The caller derefs the matched device's `.Coordinator` — that part needs the live object, this doesn't.
 */
export function matchRoom<T extends RoomLike>(
  devices: readonly T[],
  target: string,
): T | undefined {
  const t = target.toLowerCase();
  return (
    devices.find((d) => d.Name.toLowerCase() === t) ??
    devices.find((d) => (d.GroupName ?? "").toLowerCase().includes(t))
  );
}
