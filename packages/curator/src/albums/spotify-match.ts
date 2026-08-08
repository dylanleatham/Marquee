// Fuzzy-match a Discogs release to a Spotify album so a Discogs add can use Spotify's richer,
// more consistent cover art (issue #58 / ADR 0017). Deliberately conservative: a wrong match would
// put the *wrong* cover on an album, so we only accept a candidate whose artist AND title both match
// closely; year is a tiebreaker, not a gate (reissues differ). No confident match → the caller keeps
// the Discogs image. Pure + string-only, so it's unit-tested without the network.
import type { SpotifyAlbumMeta } from "../spotify/client.js";
import type { AlbumMetadata } from "./asset.js";

export interface MatchQuery {
  artist: string;
  title: string;
  year?: number;
}

// Ligatures/special letters NFKD leaves intact — map them so "Ágætis" matches "Agaetis", etc.
const LIGATURES: Record<string, string> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ß: "ss",
  ł: "l",
  đ: "d",
  þ: "th",
  ð: "d",
};

/** Lowercase, expand ligatures, strip accents + punctuation, collapse whitespace — for comparison. */
const norm = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[æœøßłđþð]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Drop edition/format parentheticals ("(Deluxe Edition)", "[Remastered 2011]") before comparing. */
const stripEditions = (s: string): string =>
  s.replace(/[([][^)\]]*[)\]]/g, " ");

/** True if two normalized strings are equal, or one contains the other and is a substantial share of
 * it (so "Hits" doesn't match "Greatest Hits Vol. 2", but "Blue" matches "Blue (Remastered)"). */
function closeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length / long.length >= 0.6;
}

/**
 * How sure we are, which decides what the match is allowed to be used for
 * ([ADR 0059](../../../../docs/adrs/0059-a-matched-album-plays-only-on-an-exact-match.md)):
 *
 * - `exact` — artist and title agree outright once normalized, and the years don't disagree. This is
 *   the only verdict allowed to name an album for **playback**.
 * - `close` — qualifies under `closeMatch`'s substring rule, or the years are far apart. Good enough
 *   to borrow a **cover**, which is all ADR 0017 ever asked of this function.
 *
 * The asymmetry is the point: a wrong cover is embarrassing and instantly obvious; a wrong album
 * playing in a room full of people is neither.
 */
export type MatchConfidence = "exact" | "close";

export interface SpotifyMatch {
  album: SpotifyAlbumMeta;
  confidence: MatchConfidence;
}

/** A year gap this wide means these are probably different releases, not one reissued. */
const YEAR_TOLERANCE = 1;

/**
 * The best confident Spotify match for a Discogs release, or `null`. A candidate qualifies only if
 * its artist and (edition-stripped) title both `closeMatch` the query and it actually carries cover
 * art. Among qualifiers, exact artist/title and a matching year score higher; a year off by more than
 * one is a demerit but not disqualifying.
 *
 * Returns the match **and its confidence** — callers decide which bar they need. The `artUrl` filter
 * below is inherited from the cover-art purpose and kept deliberately: an album Spotify has no art
 * for is a thin enough record that we'd rather not bet audio on it either.
 */
export function bestSpotifyMatch(
  query: MatchQuery,
  candidates: SpotifyAlbumMeta[],
): SpotifyMatch | null {
  const qArtist = norm(query.artist);
  const qTitle = norm(stripEditions(query.title));
  if (!qArtist || !qTitle) return null;

  let best: { album: SpotifyAlbumMeta; score: number; exact: boolean } | null =
    null;
  for (const c of candidates) {
    if (!c.artUrl) continue; // no art → useless for the purpose
    const cArtist = norm(c.artist);
    const cTitle = norm(stripEditions(c.name));
    if (!closeMatch(qArtist, cArtist) || !closeMatch(qTitle, cTitle)) continue;

    const artistExact = cArtist === qArtist;
    const titleExact = cTitle === qTitle;
    // An unknown year on either side is not evidence against — plenty of Discogs pressings carry
    // none, and refusing those would be refusing most of a real collection.
    const yearsKnown = query.year !== undefined && c.year !== undefined;
    const gap = yearsKnown ? Math.abs(c.year! - query.year!) : 0;
    const yearOk = !yearsKnown || gap <= YEAR_TOLERANCE;

    let score = 0;
    score += artistExact ? 2 : 1;
    score += titleExact ? 2 : 1;
    if (yearsKnown) score += gap === 0 ? 2 : gap <= YEAR_TOLERANCE ? 1 : -1;

    const exact = artistExact && titleExact && yearOk;
    if (!best || score > best.score) best = { album: c, score, exact };
  }
  if (!best) return null;
  return { album: best.album, confidence: best.exact ? "exact" : "close" };
}

/**
 * Fold a match into an album's metadata. `close` lends its cover and nothing else; `exact` also
 * names the album for playback (ADR 0059). Exported so the backfill applies exactly the same rule as
 * the onboarding step — two implementations of "is this good enough to play" is how they drift.
 */
export function applySpotifyMatch(
  metadata: AlbumMetadata,
  match: SpotifyMatch | null,
  now: () => string,
): AlbumMetadata {
  if (!match) return metadata;
  const { album, confidence } = match;
  return {
    ...metadata,
    ...(album.artUrl ? { spotifyArtUrl: album.artUrl } : {}),
    ...(confidence === "exact" ? { spotifyUri: album.spotifyUri } : {}),
    spotifyMatch: {
      confidence,
      name: album.name,
      artist: album.artist,
      ...(album.year !== undefined ? { year: album.year } : {}),
      matchedAt: now(),
    },
  };
}
