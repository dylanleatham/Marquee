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
    expect(m?.artUrl).toBe("https://art/rainbows.jpg");
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
    expect(m?.artUrl).toBe("https://art/original.jpg");
  });
});
