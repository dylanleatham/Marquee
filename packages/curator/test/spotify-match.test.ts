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
