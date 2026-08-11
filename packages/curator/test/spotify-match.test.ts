import { describe, it, expect } from "vitest";
import { bestSpotifyMatch } from "../src/albums/spotify-match.js";
import type { SpotifyAlbumMeta } from "../src/spotify/client.js";

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
    expect(m?.album.artUrl).toBe("https://art/rainbows.jpg");
  });

  it("ignores edition/format parentheticals on the title", () => {
    const m = bestSpotifyMatch(
      { artist: "Daft Punk", title: "Discovery (Japanese Edition)" },
      [album({ name: "Discovery", artist: "Daft Punk", year: 2001 })],
    );
    expect(m).not.toBeNull();
  });

  it("tolerates accents and punctuation differences", () => {
    const m = bestSpotifyMatch(
      { artist: "Sigur Rós", title: "Ágætis byrjun" },
      [album({ name: "Agaetis byrjun", artist: "Sigur Ros" })],
    );
    expect(m).not.toBeNull();
  });

  it("rejects when the artist doesn't match (no wrong-cover)", () => {
    const m = bestSpotifyMatch({ artist: "Prince", title: "1999" }, [
      album({ name: "1999", artist: "Cheap Trick" }),
    ]);
    expect(m).toBeNull();
  });

  it("does not let a short title match a longer unrelated one", () => {
    const m = bestSpotifyMatch({ artist: "ABBA", title: "Hits" }, [
      album({ name: "Greatest Hits Volume Two", artist: "ABBA" }),
    ]);
    expect(m).toBeNull();
  });

  it("skips candidates with no cover art", () => {
    const m = bestSpotifyMatch({ artist: "Björk", title: "Homogenic" }, [
      album({ name: "Homogenic", artist: "Björk", artUrl: undefined }),
    ]);
    expect(m).toBeNull();
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
    expect(m?.album.artUrl).toBe("https://art/original.jpg");
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
    expect(m?.confidence).toBe("exact");
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
    expect(m).not.toBeNull();
    expect(m?.confidence).toBe("close");
  });

  it("calls a substring artist `close`", () => {
    const m = bestSpotifyMatch(
      { artist: "The Beatles", title: "Let It Be", year: 1970 },
      [album({ name: "Let It Be", artist: "The Beatles Live", year: 1970 })],
    );
    expect(m).not.toBeNull();
    expect(m?.confidence).toBe("close");
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
      expect(m?.confidence, `year ${year}`).toBe("exact");
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
    expect(m?.album.artUrl).toBe("https://art/original.jpg");
  });

  /**
   * Discogs disambiguates a duplicate artist name with a trailing number — `Costanza (5)`. That is a
   * database artifact, and leaving it in made a correct match read as a different artist.
   */
  it("ignores Discogs's (n) artist disambiguator", () => {
    const m = bestSpotifyMatch({ artist: "Costanza (5)", title: "George" }, [
      album({ name: "George", artist: "Costanza" }),
    ]);
    expect(m?.confidence).toBe("exact");
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
    expect(m).toBeNull();
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
    expect(m?.album.artUrl).toBe("https://art/blue.jpg");
    expect(m?.confidence).toBe("exact");
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
      expect(m, `gap ${gap}`).toBeNull();
    }
  });

  /** Namesakes and no year to separate them at all — the most honest possible "don't know". */
  it("refuses between namesakes when the pressing has no year", () => {
    const m = bestSpotifyMatch({ artist: "Weezer", title: "Weezer" }, [
      album({ name: "Weezer", artist: "Weezer", year: 1994 }),
      album({ name: "Weezer", artist: "Weezer", year: 2019 }),
    ]);
    expect(m).toBeNull();
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
    expect(m).not.toBeNull();
    expect(m?.album.artUrl).toBe("https://art/original.jpg");
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
    expect(m?.confidence).toBe("exact");
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
    expect(m?.confidence).toBe("exact");
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
    expect(m?.album.artUrl).toBe("https://art/r.jpg");
    expect(m?.album.spotifyUri).toBe("spotify:album:id");
  });
});
