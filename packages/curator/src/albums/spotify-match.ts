// Fuzzy-match a Discogs release to a Spotify album so a Discogs add can use Spotify's richer,
// more consistent cover art (issue #58 / ADR 0017). Deliberately conservative: a wrong match would
// put the *wrong* cover on an album, so we only accept a candidate whose artist AND title both match
// closely; year is a tiebreaker, not a gate (reissues differ). No confident match → the caller keeps
// the Discogs image. Pure + string-only, so it's unit-tested without the network.
import type { SpotifyAlbumMeta } from "../spotify/client.js";

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
 * The best confident Spotify match for a Discogs release, or `null`. A candidate qualifies only if
 * its artist and (edition-stripped) title both `closeMatch` the query and it actually carries cover
 * art. Among qualifiers, exact artist/title and a matching year score higher; a year off by more than
 * one is a demerit but not disqualifying.
 */
export function bestSpotifyMatch(
  query: MatchQuery,
  candidates: SpotifyAlbumMeta[],
): SpotifyAlbumMeta | null {
  const qArtist = norm(query.artist);
  const qTitle = norm(stripEditions(query.title));
  if (!qArtist || !qTitle) return null;

  let best: { album: SpotifyAlbumMeta; score: number } | null = null;
  for (const c of candidates) {
    if (!c.artUrl) continue; // no art → useless for the purpose
    const cArtist = norm(c.artist);
    const cTitle = norm(stripEditions(c.name));
    if (!closeMatch(qArtist, cArtist) || !closeMatch(qTitle, cTitle)) continue;

    let score = 0;
    score += cArtist === qArtist ? 2 : 1;
    score += cTitle === qTitle ? 2 : 1;
    if (query.year !== undefined && c.year !== undefined) {
      const gap = Math.abs(c.year - query.year);
      score += gap === 0 ? 2 : gap <= 1 ? 1 : -1;
    }
    if (!best || score > best.score) best = { album: c, score };
  }
  return best?.album ?? null;
}
