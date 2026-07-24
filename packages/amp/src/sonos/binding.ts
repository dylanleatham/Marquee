// Pure parsing of the household's Spotify binding out of a Sonos Favorites (FV:2) DIDL. Kept separate
// from svrooij-driver.ts (which imports the whole @svrooij/sonos library) so this firmware-coupled,
// fragile bit is unit-tested against a real favorite's DIDL without any hardware or heavy import
// (amp-spec §13 calls for exactly this regression test).

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
