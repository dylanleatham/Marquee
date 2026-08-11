import { describe, it, expect } from "vitest";
import {
  bestSpotifyMatch,
  applySpotifyMatch,
  type MatchOutcome,
} from "../src/albums/spotify-match.js";
import type { SpotifyAlbumMeta } from "../src/spotify/client.js";

/**
 * The matched arm, or null. Most of this file asks "what did it pick", which only `matched` answers
 * — narrowing here keeps every such test one line instead of three, and makes a test that expected a
 * match but got `ambiguous`/`none` read as `null` rather than failing on a property of undefined.
 */
const picked = (o: MatchOutcome) => (o.kind === "matched" ? o : null);

const album = (over: Partial<SpotifyAlbumMeta>): SpotifyAlbumMeta => ({
  spotifyId: "id",
  spotifyUri: "spotify:album:id",
  name: "Album",
  artist: "Artist",
  artUrl: "https://art/x.jpg",
  ...over,
});

describe("bestSpotifyMatch (issue #58)", () => {
  it("matches on artist + title and returns the candidate", () => {
    const m = bestSpotifyMatch(
      { artist: "Radiohead", title: "In Rainbows", year: 2007 },
      [
        album({ name: "Amnesiac", artist: "Radiohead", year: 2001 }),
        album({
          name: "In Rainbows",
          artist: "Radiohead",
          year: 2007,
          artUrl: "https://art/rainbows.jpg",
        }),
      ],
    );
    expect(picked(m)?.album.artUrl).toBe("https://art/rainbows.jpg");
  });

  it("ignores edition/format parentheticals on the title", () => {
    const m = bestSpotifyMatch(
      { artist: "Daft Punk", title: "Discovery (Japanese Edition)" },
      [album({ name: "Discovery", artist: "Daft Punk", year: 2001 })],
    );
    expect(m.kind).toBe("matched");
  });

  it("tolerates accents and punctuation differences", () => {
    const m = bestSpotifyMatch(
      { artist: "Sigur Rós", title: "Ágætis byrjun" },
      [album({ name: "Agaetis byrjun", artist: "Sigur Ros" })],
    );
    expect(m.kind).toBe("matched");
  });

  it("rejects when the artist doesn't match (no wrong-cover)", () => {
    const m = bestSpotifyMatch({ artist: "Prince", title: "1999" }, [
      album({ name: "1999", artist: "Cheap Trick" }),
    ]);
    expect(m.kind).toBe("none");
  });

  it("does not let a short title match a longer unrelated one", () => {
    const m = bestSpotifyMatch({ artist: "ABBA", title: "Hits" }, [
      album({ name: "Greatest Hits Volume Two", artist: "ABBA" }),
    ]);
    expect(m.kind).toBe("none");
  });

  it("skips candidates with no cover art", () => {
    const m = bestSpotifyMatch({ artist: "Björk", title: "Homogenic" }, [
      album({ name: "Homogenic", artist: "Björk", artUrl: undefined }),
    ]);
    expect(m.kind).toBe("none");
  });

  it("prefers the exact-year candidate among title/artist matches", () => {
    const m = bestSpotifyMatch(
      { artist: "Nas", title: "Illmatic", year: 1994 },
      [
        album({
          name: "Illmatic",
          artist: "Nas",
          year: 2004, // reissue — off by 10
          artUrl: "https://art/reissue.jpg",
        }),
        album({
          name: "Illmatic",
          artist: "Nas",
          year: 1994, // original
          artUrl: "https://art/original.jpg",
        }),
      ],
    );
    expect(picked(m)?.album.artUrl).toBe("https://art/original.jpg");
  });
});

/**
 * Two bars, one matcher (ADR 0059). ADR 0017 built this to pick a **cover**, where a wrong match is
 * an embarrassing sleeve. Reusing the same verdict to decide **what audio plays** raises the stakes:
 * a bad match puts the wrong record through the speakers in front of people. So a match now carries a
 * confidence, and only `exact` is allowed to name an album for playback.
 */
describe("match confidence — what may play audio", () => {
  it("calls an exact artist + title + year agreement `exact`", () => {
    const m = bestSpotifyMatch(
      { artist: "Portishead", title: "Dummy", year: 1994 },
      [album({ name: "Dummy", artist: "Portishead", year: 1994 })],
    );
    expect(picked(m)?.confidence).toBe("exact");
  });

  /**
   * `closeMatch` accepts a substring covering ≥60% of the longer string — deliberately, so "Blue"
   * finds "Blue (Remastered)". Right for a cover, wrong for audio: at that threshold a Discogs
   * "Discovery" also matches a Spotify "Discovery One", which is a different record.
   *
   * (The obvious example, "Live" vs "Live at Leeds", is **not** a match at all — 4/13 is under the
   * threshold. Worth knowing: the rule is narrower than it reads, and the cases that do slip through
   * are same-prefix titles, not arbitrary substrings.)
   */
  it("calls a substring title `close`, not exact — good enough for art, not for audio", () => {
    const m = bestSpotifyMatch({ artist: "Daft Punk", title: "Discovery" }, [
      album({ name: "Discovery One", artist: "Daft Punk", year: 2001 }),
    ]);
    expect(m.kind).toBe("matched");
    expect(picked(m)?.confidence).toBe("close");
  });

  it("calls a substring artist `close`", () => {
    const m = bestSpotifyMatch(
      { artist: "The Beatles", title: "Let It Be", year: 1970 },
      [album({ name: "Let It Be", artist: "The Beatles Live", year: 1970 })],
    );
    expect(m.kind).toBe("matched");
    expect(picked(m)?.confidence).toBe("close");
  });

  /**
   * The year does not gate anything (ADR 0060). It used to, and it measured the wrong thing: on a
   * real collection 163 of 213 refusals were **vinyl reissues** — Discogs catalogues the *pressing*,
   * Spotify the *release*, so a 2016 repress of a 1995 album disagreed by 21 years while being
   * unambiguously the same record.
   */
  it("stays exact however far apart the years are", () => {
    for (const year of [1985, 2015, 2026]) {
      const m = bestSpotifyMatch(
        { artist: "Prince", title: "Purple Rain", year: 1984 },
        [album({ name: "Purple Rain", artist: "Prince", year })],
      );
      expect(picked(m)?.confidence, `year ${year}`).toBe("exact");
    }
  });

  /** It still *ranks*: among same-name albums, the one nearest your pressing wins. */
  it("uses the year to pick between candidates of the same name", () => {
    const m = bestSpotifyMatch(
      { artist: "Prince", title: "Purple Rain", year: 1984 },
      [
        album({
          name: "Purple Rain",
          artist: "Prince",
          year: 2015,
          artUrl: "https://art/reissue.jpg",
        }),
        album({
          name: "Purple Rain",
          artist: "Prince",
          year: 1984,
          artUrl: "https://art/original.jpg",
        }),
      ],
    );
    expect(picked(m)?.album.artUrl).toBe("https://art/original.jpg");
  });

  /**
   * Discogs disambiguates a duplicate artist name with a trailing number — `Costanza (5)`. That is a
   * database artifact, and leaving it in made a correct match read as a different artist.
   */
  it("ignores Discogs's (n) artist disambiguator", () => {
    const m = bestSpotifyMatch({ artist: "Costanza (5)", title: "George" }, [
      album({ name: "George", artist: "Costanza" }),
    ]);
    expect(picked(m)?.confidence).toBe("exact");
  });

  /**
   * regression: [#288](https://github.com/dylanleatham/Marquee/issues/288) — the Blue Album wore the
   * Teal Album's sleeve.
   *
   * Weezer have six self-titled albums. A 2020 repress of the 1994 Blue Album asks this function for
   * `{ Weezer, Weezer, 2020 }`; all six are exact on artist and title, so the year decided, and it
   * picked Teal (2019) — a different record released twenty-five years after the one on the shelf.
   *
   * Nearest-to-pressing-year only means "right edition" when the same-named candidates are editions
   * of one record. Among genuinely different records sharing a name it means nothing, and on a
   * repress — the ordinary case per ADR 0060 — it actively misleads.
   */
  it("refuses to pick between an artist's several self-titled albums", () => {
    const weezer = (year: number, art: string) =>
      album({ name: "Weezer", artist: "Weezer", year, artUrl: art });
    const m = bestSpotifyMatch(
      { artist: "Weezer", title: "Weezer", year: 2020 }, // a 2020 repress of the 1994 Blue Album
      [
        weezer(1994, "https://art/blue.jpg"),
        weezer(2001, "https://art/green.jpg"),
        weezer(2008, "https://art/red.jpg"),
        weezer(2016, "https://art/white.jpg"),
        weezer(2019, "https://art/teal.jpg"),
        weezer(2019, "https://art/black.jpg"),
      ],
    );
    // Not `none` (#289): it found them, all six, and declined — a different fact from "nothing came
    // back", and the only one that justifies telling the owner the backfill cannot help.
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.candidates).toHaveLength(6);
  });

  /**
   * The candidates are the deliverable, not diagnostics (#289) — the record page offers them as the
   * pick-list, so they have to be all of them and in an order a human can scan. Oldest first: that
   * is how a discography reads, and how someone holding one of six identical sleeves finds theirs.
   */
  it("hands back every namesake it declined, oldest first", () => {
    const weezer = (year: number) =>
      album({
        name: "Weezer",
        artist: "Weezer",
        year,
        artUrl: `https://art/${year}.jpg`,
      });
    const m = bestSpotifyMatch(
      { artist: "Weezer", title: "Weezer", year: 2020 },
      [weezer(2016), weezer(1994), weezer(2019), weezer(2001)],
    );
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" && m.candidates.map((c) => c.year)).toEqual([
      1994, 2001, 2016, 2019,
    ]);
  });

  /**
   * The subtle one. ADR 0067 treats a same-year twin as a cross-market duplicate when *deciding* to
   * refuse, so it isn't counted as a rival. Teal and Black are both 2019 and both called `Weezer`,
   * which makes that assumption wrong for exactly this pair — so the two sets have to differ: the
   * refusal ignores same-year twins, the pick-list keeps them. A list that dropped one would be
   * missing the record on the shelf for whoever owns the Black Album.
   */
  it("offers a same-year twin even though it was not counted as a rival", () => {
    const m = bestSpotifyMatch(
      { artist: "Weezer", title: "Weezer", year: 2020 },
      [
        album({ name: "Weezer", artist: "Weezer", year: 1994 }),
        album({
          name: "Weezer",
          artist: "Weezer",
          year: 2019,
          artUrl: "https://art/teal.jpg",
        }),
        album({
          name: "Weezer",
          artist: "Weezer",
          year: 2019,
          artUrl: "https://art/black.jpg",
        }),
      ],
    );
    const arts =
      m.kind === "ambiguous" ? m.candidates.map((c) => c.artUrl) : [];
    expect(arts).toContain("https://art/teal.jpg");
    expect(arts).toContain("https://art/black.jpg");
  });

  /**
   * The pick-list is the *namesakes*, not everything that qualified. A deluxe edition qualifies —
   * `stripEditions` flattens it to the same title, which is exactly what lets "Purple Rain" find
   * "Purple Rain (Deluxe)" — but it is the same record in a different dress, not one of the six
   * things this record might be. Offering it would make the picker say the tie was wider than it
   * was, and put a row in it that answers a question nobody asked.
   *
   * (An outright unrelated album like "Pinkerton" never reaches this decision — `closeMatch` drops
   * it long before. The deluxe edition is the case that gets all the way here and still must not be
   * offered, which makes it the one worth asserting.)
   */
  it("does not offer an edition that was never one of the namesakes", () => {
    const m = bestSpotifyMatch(
      { artist: "Weezer", title: "Weezer", year: 2020 },
      [
        album({ name: "Weezer", artist: "Weezer", year: 1994 }),
        album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        album({
          name: "Weezer (Deluxe Edition)",
          artist: "Weezer",
          year: 2004,
        }),
        album({ name: "Pinkerton", artist: "Weezer", year: 1996 }),
      ],
    );
    expect(m.kind === "ambiguous" && m.candidates.map((c) => c.name)).toEqual([
      "Weezer",
      "Weezer",
    ]);
  });

  /** The other half of the rule: when the year *does* land, it has genuinely identified the record. */
  it("picks the right self-titled album when the year lands exactly", () => {
    const m = bestSpotifyMatch(
      { artist: "Weezer", title: "Weezer", year: 1994 }, // an original 1994 pressing
      [
        album({
          name: "Weezer",
          artist: "Weezer",
          year: 1994,
          artUrl: "https://art/blue.jpg",
        }),
        album({
          name: "Weezer",
          artist: "Weezer",
          year: 2019,
          artUrl: "https://art/teal.jpg",
        }),
      ],
    );
    expect(picked(m)?.album.artUrl).toBe("https://art/blue.jpg");
    expect(picked(m)?.confidence).toBe("exact");
  });

  /**
   * A near miss is not weak evidence, it is no evidence — so the size of the miss must not matter.
   * Parametrized because "off by one is surely fine" is exactly the reasoning that produced #288:
   * the Teal Album was one year off.
   */
  it("refuses at every distance when only the year separates two namesakes", () => {
    for (const gap of [1, 2, 5, 25]) {
      const m = bestSpotifyMatch(
        { artist: "Weezer", title: "Weezer", year: 2020 },
        [
          album({ name: "Weezer", artist: "Weezer", year: 2020 - gap }),
          album({ name: "Weezer", artist: "Weezer", year: 1994 }),
        ],
      );
      expect(m.kind, `gap ${gap}`).toBe("ambiguous");
    }
  });

  /** Namesakes and no year to separate them at all — the most honest possible "don't know". */
  it("refuses between namesakes when the pressing has no year", () => {
    const m = bestSpotifyMatch({ artist: "Weezer", title: "Weezer" }, [
      album({ name: "Weezer", artist: "Weezer", year: 1994 }),
      album({ name: "Weezer", artist: "Weezer", year: 2019 }),
    ]);
    expect(m.kind).toBe("ambiguous");
  });

  /**
   * The guard keys on the **raw** title, so it does not sweep up the case `stripEditions` was built
   * for. A deluxe reissue is the same record in a different dress: ranking between it and the
   * original is meaningful, and picking either puts the right sleeve on the shelf. Were this keyed
   * on the stripped title, every album with a deluxe edition would stop matching — which would
   * re-open the mass-refusal problem ADR 0060 was written to close.
   */
  it("does not treat a deluxe edition as a namesake", () => {
    const m = bestSpotifyMatch(
      { artist: "Prince", title: "Purple Rain", year: 2015 }, // a repress, matching neither year
      [
        album({
          name: "Purple Rain",
          artist: "Prince",
          year: 1984,
          artUrl: "https://art/original.jpg",
        }),
        album({
          name: "Purple Rain (Deluxe Expanded Edition)",
          artist: "Prince",
          year: 2017,
          artUrl: "https://art/deluxe.jpg",
        }),
      ],
    );
    expect(m.kind).toBe("matched");
    expect(picked(m)?.album.artUrl).toBe("https://art/original.jpg");
  });

  it("does not strip a parenthetical that is part of the name", () => {
    const m = bestSpotifyMatch(
      { artist: "Godspeed You! Black Emperor", title: "Lift Yr Skinny Fists" },
      [
        album({
          name: "Lift Yr Skinny Fists",
          artist: "Godspeed You! Black Emperor",
        }),
      ],
    );
    expect(picked(m)?.confidence).toBe("exact");
  });

  it("stays exact when either side has no year", () => {
    const m = bestSpotifyMatch(
      { artist: "Aphex Twin", title: "Selected Ambient Works 85-92" },
      [
        album({
          name: "Selected Ambient Works 85-92",
          artist: "Aphex Twin",
          year: 1992,
        }),
      ],
    );
    expect(picked(m)?.confidence).toBe("exact");
  });

  it("still returns the album itself, so the art path is unchanged", () => {
    const m = bestSpotifyMatch(
      { artist: "Radiohead", title: "In Rainbows", year: 2007 },
      [
        album({
          name: "In Rainbows",
          artist: "Radiohead",
          year: 2007,
          artUrl: "https://art/r.jpg",
        }),
      ],
    );
    expect(picked(m)?.album.artUrl).toBe("https://art/r.jpg");
    expect(picked(m)?.album.spotifyUri).toBe("spotify:album:id");
  });
});

/**
 * What the outcome leaves on the asset ([#289](https://github.com/dylanleatham/Marquee/issues/289)).
 *
 * `applySpotifyMatch` is the single place both the onboarding step and the unattended sweep fold a
 * verdict into metadata, so it is also the single place the "ambiguous is not the same as unmatched"
 * promise is either kept or quietly broken.
 */
describe("applySpotifyMatch — recording ambiguity", () => {
  const NOW = "2026-08-10T12:00:00.000Z";
  const base = {
    name: "Weezer",
    artist: "Weezer",
    source: "discogs" as const,
    year: 2020,
  };

  it("marks an ambiguous record with the count, and no candidate list", () => {
    const next = applySpotifyMatch(
      base,
      {
        kind: "ambiguous",
        candidates: [
          album({ name: "Weezer", artist: "Weezer", year: 1994 }),
          album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        ],
      },
      () => NOW,
    );
    expect(next.spotifyAmbiguous).toEqual({
      candidateCount: 2,
      detectedAt: NOW,
    });
    // The albums themselves belong to Spotify, not to this record — the store keeps choices, not
    // catalogues. Anything that serialised a candidate list here would go stale on the next reissue.
    expect(JSON.stringify(next)).not.toContain("spotify:album:");
  });

  it("never lends a cover or a playback URI from an album it refused to choose", () => {
    const next = applySpotifyMatch(
      base,
      {
        kind: "ambiguous",
        candidates: [
          album({ name: "Weezer", artist: "Weezer", year: 1994 }),
          album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        ],
      },
      () => NOW,
    );
    expect(next.spotifyUri).toBeUndefined();
    expect(next.spotifyArtUrl).toBeUndefined();
  });

  /**
   * The two markers answer the same question — "what Spotify album is this?" — so a record carrying
   * both would be saying two contradictory things, and the record page reads whichever it checks
   * first. Naming an album by hand after an ambiguous sweep is the ordinary way to reach this.
   */
  it("clears the ambiguity once something does name the album", () => {
    const ambiguous = applySpotifyMatch(
      base,
      {
        kind: "ambiguous",
        candidates: [
          album({ name: "Weezer", artist: "Weezer", year: 1994 }),
          album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        ],
      },
      () => NOW,
    );
    const resolved = applySpotifyMatch(
      ambiguous,
      {
        kind: "matched",
        album: album({ name: "Weezer", artist: "Weezer", year: 1994 }),
        confidence: "exact",
      },
      () => NOW,
    );
    expect(resolved.spotifyAmbiguous).toBeUndefined();
    expect(resolved.spotifyMatch?.confidence).toBe("exact");
  });

  /** And the reverse: a record that becomes ambiguous must not keep an old match's verdict. */
  it("drops a stale match when the answer becomes ambiguous", () => {
    const matched = applySpotifyMatch(
      base,
      {
        kind: "matched",
        album: album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        confidence: "exact",
      },
      () => NOW,
    );
    const ambiguous = applySpotifyMatch(
      matched,
      {
        kind: "ambiguous",
        candidates: [
          album({ name: "Weezer", artist: "Weezer", year: 1994 }),
          album({ name: "Weezer", artist: "Weezer", year: 2019 }),
        ],
      },
      () => NOW,
    );
    expect(ambiguous.spotifyMatch).toBeUndefined();
    expect(ambiguous.spotifyAmbiguous?.candidateCount).toBe(2);
  });

  it("leaves metadata untouched when nothing was found", () => {
    expect(applySpotifyMatch(base, { kind: "none" }, () => NOW)).toEqual(base);
  });
});
