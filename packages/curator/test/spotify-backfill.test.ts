// Backfilling the Spotify identity of Discogs albums (ADR 0059).
//
// The sweep exists because the onboarding fix only helps albums added *after* it. What it must not
// do is as important as what it must: never overwrite an identity already on disk, never let a
// `close` match name an album for playback, and never grind through a whole library discovering
// Spotify is rate-limiting it.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { spotifyBackfillRunner } from "../src/albums/spotify-backfill.js";
import type { SpotifyClient, SpotifyAlbumMeta } from "../src/spotify/client.js";
import { makeAsset } from "./helpers.js";

const NOW = "2026-08-08T00:00:00.000Z";

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-backfill-")));

/** A Discogs album as the sweep finds it on disk: named, covered, and unplayable. */
const seedDiscogs = (
  s: AssetStore,
  curatorId: string,
  over: {
    name?: string;
    artist?: string;
    year?: number;
    spotifyUri?: string;
  } = {},
) => {
  const asset = makeAsset(
    curatorId,
    over.name ?? "In Rainbows",
    over.artist ?? "Radiohead",
  );
  asset.metadata = {
    ...asset.metadata,
    source: "discogs",
    discogsReleaseId: 1,
    discogsUri: "discogs:release:1",
    year: over.year ?? 2007,
    ...(over.spotifyUri ? { spotifyUri: over.spotifyUri } : {}),
  };
  asset.roadie.state = "awaiting_review";
  s.save(asset);
  return curatorId;
};

const spotify = (results: Partial<SpotifyAlbumMeta>[]): SpotifyClient =>
  ({
    searchAlbums: async () =>
      results.map((r) => ({
        spotifyId: "sp1",
        spotifyUri: "spotify:album:sp1",
        name: "In Rainbows",
        artist: "Radiohead",
        year: 2007,
        artUrl: "https://art/x.jpg",
        genres: [],
        ...r,
      })),
  }) as unknown as SpotifyClient;

const run = (s: AssetStore, client: SpotifyClient) =>
  spotifyBackfillRunner({ store: s, spotify: client, now: () => NOW })({
    onProgress: () => {},
    signal: new AbortController().signal,
  });

describe("spotifyBackfillRunner", () => {
  let s: AssetStore;
  beforeEach(() => {
    s = store();
  });

  it("names an exactly-matched album so it can finally play", async () => {
    seedDiscogs(s, "aaaa1111");
    const { spotifyBackfill: r } = await run(s, spotify([{}]));

    expect(r.matched).toBe(1);
    const saved = s.read("aaaa1111")!;
    expect(saved.metadata.spotifyUri).toBe("spotify:album:sp1");
    expect(saved.metadata.spotifyMatch).toMatchObject({ confidence: "exact" });
    expect(r.items[0]).toMatchObject({
      status: "matched",
      matchedTo: "Radiohead — In Rainbows",
    });
  });

  /** The whole reason for two bars: a close match may lend a cover and must not start audio. */
  it("takes a close match's cover but refuses to make it playable", async () => {
    seedDiscogs(s, "aaaa1111");
    const { spotifyBackfill: r } = await run(
      s,
      spotify([{ name: "In Rainbows Disk 2", artUrl: "https://art/d2.jpg" }]),
    );

    expect(r.artOnly).toBe(1);
    expect(r.matched).toBe(0);
    const saved = s.read("aaaa1111")!;
    expect(saved.metadata.spotifyArtUrl).toBe("https://art/d2.jpg");
    expect(saved.metadata.spotifyUri).toBeUndefined();
  });

  /**
   * An existing URI is either a Spotify add or an earlier exact match — both facts. Re-deriving
   * could only replace a fact with a guess, so the sweep never touches one.
   */
  it("never overwrites an album that already has a Spotify URI", async () => {
    seedDiscogs(s, "aaaa1111", { spotifyUri: "spotify:album:original" });
    const { spotifyBackfill: r } = await run(
      s,
      spotify([{ spotifyUri: "spotify:album:different" }]),
    );

    expect(r.items[0]!.status).toBe("skipped_has_uri");
    expect(s.read("aaaa1111")!.metadata.spotifyUri).toBe(
      "spotify:album:original",
    );
  });

  it("leaves non-Discogs albums alone", async () => {
    s.save(makeAsset("bbbb2222", "X", "Y")); // makeAsset builds a `manual` album
    const { spotifyBackfill: r } = await run(s, spotify([{}]));

    expect(r.items[0]!.status).toBe("skipped_not_discogs");
    expect(s.read("bbbb2222")!.metadata.spotifyUri).toBeUndefined();
  });

  it("skips an album Roadie is holding, which will get its match from the step", async () => {
    seedDiscogs(s, "aaaa1111");
    s.update("aaaa1111", (a) => {
      a.roadie.state = "downloading_art";
    });
    const { spotifyBackfill: r } = await run(s, spotify([{}]));

    expect(r.items[0]!.status).toBe("skipped_processing");
    expect(s.read("aaaa1111")!.metadata.spotifyUri).toBeUndefined();
  });

  it("records a miss as a miss, not a failure", async () => {
    seedDiscogs(s, "aaaa1111");
    const { spotifyBackfill: r } = await run(s, spotify([]));

    expect(r.noMatch).toBe(1);
    expect(r.failed).toBe(0);
    expect(s.read("aaaa1111")!.metadata.spotifyMatch).toBeUndefined();
  });

  /**
   * regression: [#288](https://github.com/dylanleatham/Marquee/issues/288) — the same guard, at the
   * second surface that uses it. The sweep runs over a whole library unattended, so a wrong identity
   * written here is one nobody watched being written; the onboarding step at least happens while
   * you're looking at the record. Both go through `bestSpotifyMatch`, and this is what proves the
   * sweep inherits its refusal rather than having its own idea.
   */
  it("reports an un-tellable-apart album as ambiguous, not as a miss", async () => {
    seedDiscogs(s, "aaaa1111", {
      name: "Weezer",
      artist: "Weezer",
      year: 2020, // a repress of the 1994 Blue Album
    });
    const { spotifyBackfill: r } = await run(
      s,
      spotify(
        [1994, 2001, 2008, 2016, 2019].map((year) => ({
          spotifyId: `sp${year}`,
          spotifyUri: `spotify:album:sp${year}`,
          name: "Weezer",
          artist: "Weezer",
          year,
          artUrl: `https://art/${year}.jpg`,
        })),
      ),
    );

    // Counted apart from a miss (#289). A miss may become a hit on the next sweep; this never will,
    // so lumping them together would tell the reader to re-run the one thing that cannot help.
    expect(r.ambiguous).toBe(1);
    expect(r.noMatch).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.items[0]).toMatchObject({ status: "ambiguous" });

    const saved = s.read("aaaa1111")!;
    expect(saved.metadata.spotifyUri).toBeUndefined();
    expect(saved.metadata.spotifyArtUrl).toBeUndefined();
    // And the record itself now carries why, so the page can say it without re-searching.
    expect(saved.metadata.spotifyAmbiguous).toMatchObject({
      candidateCount: 5,
      detectedAt: NOW,
    });
  });

  /**
   * The sweep must not thrash a record it has already given up on: re-running it re-derives the same
   * ambiguity, and the count must stay a count rather than accumulating. Cheap to get wrong if the
   * marker were ever appended to instead of replaced.
   */
  it("stays ambiguous, and stays a count, when the sweep runs again", async () => {
    seedDiscogs(s, "aaaa1111", {
      name: "Weezer",
      artist: "Weezer",
      year: 2020,
    });
    const client = spotify(
      [1994, 2019].map((year) => ({
        spotifyId: `sp${year}`,
        spotifyUri: `spotify:album:sp${year}`,
        name: "Weezer",
        artist: "Weezer",
        year,
        artUrl: `https://art/${year}.jpg`,
      })),
    );

    await run(s, client);
    const { spotifyBackfill: second } = await run(s, client);

    expect(second.ambiguous).toBe(1);
    expect(s.read("aaaa1111")!.metadata.spotifyAmbiguous).toEqual({
      candidateCount: 2,
      detectedAt: NOW,
    });
  });

  it("keeps going after one album fails", async () => {
    seedDiscogs(s, "aaaa1111");
    seedDiscogs(s, "bbbb2222");
    let call = 0;
    const flaky = {
      searchAlbums: async () => {
        if (++call === 1) throw new Error("boom");
        return [
          {
            spotifyId: "sp1",
            spotifyUri: "spotify:album:sp1",
            name: "In Rainbows",
            artist: "Radiohead",
            year: 2007,
            artUrl: "https://art/x.jpg",
            genres: [],
          },
        ];
      },
    } as unknown as SpotifyClient;

    const { spotifyBackfill: r } = await run(s, flaky);
    expect(r.failed).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.abandoned).toBeUndefined();
  });

  /**
   * Ten failures in a row is not ten bad albums — it is a dead token or a rate limit, and running
   * the remaining four hundred searches to confirm that wastes minutes and requests. The report says
   * `abandoned` so a short run isn't mistaken for a clean one.
   */
  it("gives up after a run of failures, and says that it did", async () => {
    for (let i = 0; i < 15; i++)
      seedDiscogs(s, `aaaa${String(i).padStart(4, "0")}`);
    const dead = {
      searchAlbums: async () => {
        throw new Error("429 rate limited");
      },
    } as unknown as SpotifyClient;

    const { spotifyBackfill: r } = await run(s, dead);

    expect(r.abandoned).toBe(true);
    expect(r.failed).toBe(10);
    expect(r.items).toHaveLength(10); // stopped, rather than sweeping all 15
  });

  it("stops between albums when cancelled", async () => {
    seedDiscogs(s, "aaaa1111");
    seedDiscogs(s, "bbbb2222");
    const ctrl = new AbortController();
    ctrl.abort();

    const { spotifyBackfill: r } = await spotifyBackfillRunner({
      store: s,
      spotify: spotify([{}]),
      now: () => NOW,
    })({ onProgress: () => {}, signal: ctrl.signal });

    expect(r.items).toHaveLength(0);
  });

  it("reports progress across the sweep", async () => {
    seedDiscogs(s, "aaaa1111");
    seedDiscogs(s, "bbbb2222");
    const seen: Array<[number, number]> = [];
    await spotifyBackfillRunner({
      store: s,
      spotify: spotify([{}]),
      now: () => NOW,
    })({
      onProgress: (done, total) => seen.push([done, total]),
      signal: new AbortController().signal,
    });

    expect(seen[0]).toEqual([0, 2]);
    expect(seen.at(-1)).toEqual([2, 2]);
  });
});
