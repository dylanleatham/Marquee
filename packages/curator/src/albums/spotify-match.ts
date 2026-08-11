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

/**
 * Drop Discogs's artist disambiguator — it lists a second "Costanza" as `Costanza (5)`. That number
 * is a database artifact, not part of the name, and leaving it in made a correct match read as a
 * different artist (ADR 0060). Only a bare number is stripped, so a real parenthetical in an artist
 * name survives.
 */
const stripArtistDisambiguator = (s: string): string =>
  s.replace(/\s*\(\d+\)\s*$/, "");

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
 * ([ADR 0059](../../../../docs/adrs/0059-a-matched-album-plays-only-on-an-exact-match.md), rule
 * relaxed by [ADR 0060](../../../../docs/adrs/0060-the-year-is-a-tiebreak-not-a-gate.md)):
 *
 * - `exact` — artist and title agree outright once normalized. The only verdict allowed to name an
 *   album for **playback**.
 * - `close` — qualifies only under `closeMatch`'s substring rule. Good enough to borrow a **cover**,
 *   which is all ADR 0017 ever asked of this function.
 *
 * The asymmetry is still the point — a wrong cover is embarrassing and instantly obvious, a wrong
 * album playing in a room is neither. What changed is the evidence, not the principle: the year was
 * gating `exact` and it turned out to measure the wrong thing. On a real collection 163 of 213
 * refusals were **vinyl reissues** where artist and title agreed outright and only the year differed,
 * because Discogs catalogues *pressings* and Spotify catalogues *releases*. See ADR 0060.
 */
export type MatchConfidence = "exact" | "close";

export interface SpotifyMatch {
  album: SpotifyAlbumMeta;
  confidence: MatchConfidence;
}

/**
 * What the matcher concluded — three answers, not two
 * ([issue #289](https://github.com/dylanleatham/Marquee/issues/289)).
 *
 * ([ADR 0068](../../../../docs/adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md).)
 *
 * `ambiguous` is the one that had to be added. ADR 0067 taught the matcher to refuse an artist's
 * several same-titled albums, but the refusal came back as `null`, which every caller already read
 * as "searched, found nothing". Those are different facts and they want different sentences: one
 * says *look again later*, the other says *only you can settle this*. Flattening them told the
 * owner of a Weezer record to run a backfill that will decline it every time it runs, forever.
 *
 * The candidates ride along because they are the answer, not debris — the record page can offer the
 * six albums called `Weezer` and let a human do in one press what no amount of string comparison
 * will do.
 */
export type MatchOutcome =
  | ({ kind: "matched" } & SpotifyMatch)
  | { kind: "ambiguous"; candidates: SpotifyAlbumMeta[] }
  | { kind: "none" };

/**
 * How close two years have to be to count as "the same edition" when *ranking* candidates. It gates
 * nothing (ADR 0060) — a reissue disagreeing by decades is still an exact match — but among several
 * albums of the same name by the same artist, the one nearest your pressing is the one whose
 * metadata you want.
 */
const SAME_EDITION_YEARS = 1;

/**
 * Who a candidate *is*, for spotting an artist's several same-titled albums
 * ([ADR 0067](../../../../docs/adrs/0067-the-year-may-only-break-a-tie-by-hitting-it.md)).
 *
 * Deliberately the **raw** name, not the edition-stripped one. `stripEditions` exists to let
 * "Purple Rain" find "Purple Rain (Deluxe)" — those are one record in two dresses and ranking
 * between them is both meaningful and harmless. Six albums each literally called `Weezer` are a
 * different situation, and only the raw name tells them apart from the deluxe case.
 *
 * `|` is a safe joiner because `norm` reduces everything to `[a-z0-9 ]` — punctuation can never
 * survive into a normalized string, so no artist/title pair can straddle the separator and collide
 * with another.
 */
const identity = (a: { artist: string; name: string }): string =>
  `${norm(stripArtistDisambiguator(a.artist))}|${norm(a.name)}`;

/**
 * What Spotify album this Discogs release is: `matched`, `ambiguous`, or `none`. A candidate
 * qualifies only if its artist and (edition-stripped) title both `closeMatch` the query and it
 * actually carries cover art. Among qualifiers, exact artist/title and a matching year score higher;
 * a year off by more than one is a demerit but not disqualifying.
 *
 * A match carries **its confidence** — callers decide which bar they need. The `artUrl` filter below
 * is inherited from the cover-art purpose and kept deliberately: an album Spotify has no art for is
 * a thin enough record that we'd rather not bet audio on it either.
 */
export function bestSpotifyMatch(
  query: MatchQuery,
  candidates: SpotifyAlbumMeta[],
): MatchOutcome {
  const qArtist = norm(stripArtistDisambiguator(query.artist));
  const qTitle = norm(stripEditions(query.title));
  if (!qArtist || !qTitle) return { kind: "none" };

  const qualifiers: SpotifyAlbumMeta[] = [];
  let best: { album: SpotifyAlbumMeta; score: number; exact: boolean } | null =
    null;
  for (const c of candidates) {
    if (!c.artUrl) continue; // no art → useless for the purpose
    const cArtist = norm(stripArtistDisambiguator(c.artist));
    const cTitle = norm(stripEditions(c.name));
    if (!closeMatch(qArtist, cArtist) || !closeMatch(qTitle, cTitle)) continue;
    qualifiers.push(c);

    const artistExact = cArtist === qArtist;
    const titleExact = cTitle === qTitle;

    // The year still ranks candidates — among several albums of the same name by the same artist,
    // the one nearest your pressing's year is the one whose metadata you want. It no longer *gates*
    // anything: see the note on MatchConfidence.
    const yearsKnown = query.year !== undefined && c.year !== undefined;
    const gap = yearsKnown ? Math.abs(c.year! - query.year!) : 0;

    let score = 0;
    score += artistExact ? 2 : 1;
    score += titleExact ? 2 : 1;
    if (yearsKnown) score += gap === 0 ? 2 : gap <= SAME_EDITION_YEARS ? 1 : 0;

    const exact = artistExact && titleExact;
    if (!best || score > best.score) best = { album: c, score, exact };
  }
  if (!best) return { kind: "none" };

  /**
   * **The year may only break a tie by hitting it** (issue #288,
   * [ADR 0067](../../../../docs/adrs/0067-the-year-may-only-break-a-tie-by-hitting-it.md)).
   *
   * When the winner has a *namesake* — another candidate by the same artist with the same raw title
   * and a different year — artist and title have said everything they can, and the ranking above
   * chose on the year alone. That is only trustworthy when the year lands exactly. A near miss is
   * not weak evidence for the right record, it is no evidence: Discogs dates the **pressing**
   * (ADR 0060), so a repress's year is a fact about a piece of vinyl and says nothing about which
   * album it holds. Weezer's 2020 repress of the 1994 Blue Album scored the 2019 Teal Album highest
   * on exactly this reasoning.
   *
   * So: no exact year, no pick. The caller keeps the Discogs cover, which is the one that came off
   * the release the user actually owns — and is told *why*, so it doesn't read as "not found yet"
   * (#289).
   */
  const sameTitle = qualifiers.filter(
    (c) => identity(c) === identity(best!.album),
  );
  /**
   * **Deciding to refuse and deciding what to offer are different questions**, so they use different
   * sets (#289).
   *
   * The refusal turns on `namesakes` — same title, *different* year — because ADR 0067 deliberately
   * treats a same-year twin as one of Spotify's cross-market duplicates rather than a rival. Refusing
   * on those would refuse real matches.
   *
   * The pick-list is `sameTitle`, which keeps them ([ADR 0068](../../../../docs/adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md)). Weezer's Teal and Black albums are both 2019 and
   * both called `Weezer`; the duplicate assumption is wrong for exactly that pair, and a list that
   * dropped one would be missing the record on the shelf for anyone who owns it. Over-offering costs
   * a human one glance. Under-offering costs them the only route this feature exists to provide.
   */
  const namesakes = sameTitle.filter((c) => c.year !== best!.album.year);
  const yearLandsExactly =
    query.year !== undefined && best.album.year === query.year;
  if (namesakes.length > 0 && !yearLandsExactly)
    return {
      kind: "ambiguous",
      // Oldest first: a discography reads in release order, and it is the order in which someone
      // scanning six identically-named sleeves can find the one on their shelf.
      candidates: [...sameTitle].sort((a, b) => (a.year ?? 0) - (b.year ?? 0)),
    };

  return {
    kind: "matched",
    album: best.album,
    confidence: best.exact ? "exact" : "close",
  };
}

/**
 * Fold an outcome into an album's metadata. `close` lends its cover and nothing else; `exact` also
 * names the album for playback (ADR 0059). Exported so the backfill applies exactly the same rule as
 * the onboarding step — two implementations of "is this good enough to play" is how they drift.
 *
 * **`ambiguous` records that it happened and how many albums were in the way — never the albums
 * themselves.** The asset stores choices, not catalogues; the same rule keeps a twelve-row tracklist
 * off a git-tracked JSON file (see `DemoTrack` in asset.ts). The list is a live fact about Spotify
 * rather than a fact about this record, it would be stale the moment an anniversary edition appears,
 * and the record page can re-ask for it in one request when someone is actually looking.
 */
export function applySpotifyMatch(
  metadata: AlbumMetadata,
  outcome: MatchOutcome,
  now: () => string,
): AlbumMetadata {
  if (outcome.kind === "none") return metadata;

  if (outcome.kind === "ambiguous") {
    const { spotifyMatch: _drop, ...rest } = metadata;
    return {
      ...rest,
      spotifyAmbiguous: {
        candidateCount: outcome.candidates.length,
        detectedAt: now(),
      },
    };
  }

  const { album, confidence } = outcome;
  const { spotifyAmbiguous: _resolved, ...rest } = metadata;
  return {
    ...rest,
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
