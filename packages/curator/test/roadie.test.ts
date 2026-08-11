import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { Roadie } from "../src/roadie/worker.js";
import { buildFreshAsset, type AlbumMetadata } from "../src/albums/asset.js";
import { SpotifyError, type SpotifyClient } from "../src/spotify/client.js";
import type { DiscogsClient } from "../src/discogs/client.js";
import { GeminiClient } from "../src/gemini/client.js";
import { createFakeGemini } from "@marquee/fake-gemini";
import { fakeGenerate, fakePayload } from "./helpers.js";

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-roadie-")));

/** A minimal Spotify stand-in — steps only call getAlbum + downloadArt. */
const fakeSpotify = (over: Partial<SpotifyClient> = {}): SpotifyClient =>
  ({
    getAlbum: async (id: string) => ({
      spotifyId: id,
      spotifyUri: `spotify:album:${id}`,
      name: "Fetched Name",
      artist: "Fetched Artist",
      year: 1999,
      genres: ["rock"],
      artUrl: "https://i.scdn.co/image/x",
    }),
    downloadArt: async () => Buffer.from("art-bytes"),
    ...over,
  }) as unknown as SpotifyClient;

/** A minimal Discogs stand-in — steps only call getRelease + downloadArt + (via resolve) nothing. */
const fakeDiscogs = (over: Partial<DiscogsClient> = {}): DiscogsClient =>
  ({
    getRelease: async (id: number) => ({
      releaseId: id,
      discogsUri: `discogs:release:${id}`,
      title: "In Rainbows",
      artist: "Radiohead",
      year: 2007,
      genres: ["rock"],
      artUrl: "https://img.discogs.test/x.jpg",
    }),
    downloadArt: async () => Buffer.from("discogs-art"),
    ...over,
  }) as unknown as DiscogsClient;

/** Seed a fresh Discogs album (no art yet) that the worker drives from `fetching_metadata`. */
function seedDiscogs(s: AssetStore, id = "dsc11111") {
  const asset = buildFreshAsset({
    curatorId: id,
    metadata: {
      name: "",
      artist: "",
      source: "discogs",
      discogsReleaseId: 12345,
      discogsUri: "discogs:release:12345",
    },
    now: () => "2026-07-11T00:00:00.000Z",
  });
  s.save(asset);
  return id;
}

/** Seed a manual album already saved on disk with its cover, in `generating_palette`. */
function seedManual(s: AssetStore, id = "aaaa1111") {
  const metadata: AlbumMetadata = { name: "M", artist: "A", source: "manual" };
  mkdirSync(s.paths.artwork, { recursive: true });
  writeFileSync(s.paths.artworkFile(id), Buffer.from("img"));
  const asset = buildFreshAsset({
    curatorId: id,
    metadata,
    artwork: {
      resolvedPath: s.paths.relPosix(s.paths.artworkFile(id)),
      contentHash: "sha256:x",
    },
    now: () => "2026-07-11T00:00:00.000Z",
  });
  s.save(asset);
  return id;
}

const roadieFor = (
  s: AssetStore,
  over: Partial<ConstructorParameters<typeof Roadie>[0]> = {},
) =>
  new Roadie({
    store: s,
    generate: fakeGenerate,
    sleep: async () => {},
    now: () => "2026-07-11T00:00:00.000Z",
    rand: () => 0,
    ...over,
  });

describe("Roadie state machine", () => {
  it("drives a manual album generating_palette → awaiting_review", async () => {
    const s = store();
    const id = seedManual(s);
    const roadie = roadieFor(s);
    roadie.enqueue(id);
    await roadie.drain();

    const asset = s.read(id)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.roadie.subState).toBeNull();
    expect(asset.roadie.history.map((h) => h.state)).toEqual([
      "generating_palette",
      "awaiting_review",
    ]);
  });

  // ADR 0027: drafting left the pipeline because it spent two Gemini calls on every album,
  // including ones whose artifacts the user already had. Adding an album must now cost nothing.
  it("drafts no prompts and spends no Gemini calls during onboarding", async () => {
    const s = store();
    const id = seedManual(s);
    const fg = createFakeGemini({
      research: "cover facts",
      json: { variants: [{ text: "v", nudge: "n" }] },
    });
    const gemini = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    const roadie = roadieFor(s, { gemini });
    roadie.enqueue(id);
    await roadie.drain();

    const asset = s.read(id)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.promptDrafts).toBeUndefined();
    expect(asset.roadie.history.map((h) => h.state)).not.toContain(
      "drafting_prompts",
    );
    expect(fg.calls()).toHaveLength(0);
  });

  // An album persisted mid-pipeline by a pre-ADR-0027 build must still be able to finish rather
  // than wedge on a state nothing transitions into any more.
  it("still completes an album left parked in drafting_prompts by an older build", async () => {
    const s = store();
    const id = seedManual(s);
    const parked = s.read(id)!;
    parked.palette = {
      colors: [{ hex: "#112233", role: "primary" }],
      generatedAt: "2026-07-11T00:00:00.000Z",
      algorithm: "palette-press",
      handEdited: false,
    };
    parked.roadie.state = "drafting_prompts";
    s.save(parked);

    const roadie = roadieFor(s);
    roadie.enqueue(id);
    await roadie.drain();

    const asset = s.read(id)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.promptDrafts!.video).toBeDefined();
  });

  it("drives a Spotify album through fetch → download → palette", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "bbbb2222",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:bbbb2222",
      },
      now: () => "2026-07-11T00:00:00.000Z",
    });
    s.save(asset);
    const roadie = roadieFor(s, { spotify: fakeSpotify() });
    roadie.enqueue("bbbb2222");
    await roadie.drain();

    const done = s.read("bbbb2222")!;
    expect(done.metadata.name).toBe("Fetched Name");
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.roadie.history.map((h) => h.state)).toEqual([
      "fetching_metadata",
      "downloading_art",
      "generating_palette",
      "awaiting_review",
    ]);
  });

  it("parks a monochrome album at awaiting_review with no prompts drafted", async () => {
    const s = store();
    const id = seedManual(s, "cccc3333");
    const insufficient = async () => ({
      ...fakePayload(),
      palette: {
        colors: [],
        insufficient: true as const,
        reason: "monochrome" as const,
      },
    });
    const roadie = roadieFor(s, { generate: insufficient });
    roadie.enqueue(id);
    await roadie.drain();

    const asset = s.read(id)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.roadie.flags.palette_insufficient).toBe(true);
    expect(asset.promptDrafts).toBeUndefined();
  });
});

describe("Discogs → Spotify art resolution (issue #58)", () => {
  const spotifyWithMatch = () =>
    fakeSpotify({
      searchAlbums: async () => [
        {
          spotifyId: "sp1",
          spotifyUri: "spotify:album:sp1",
          name: "In Rainbows",
          artist: "Radiohead",
          year: 2007,
          artUrl: "https://i.scdn.test/rainbows",
        },
      ],
      downloadArt: async () => Buffer.from("spotify-art"),
    });

  const artBytes = (s: AssetStore, id: string) =>
    readFileSync(s.paths.artworkFile(id)).toString();

  it("uses Spotify art on a confident match", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: spotifyWithMatch(),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.metadata.spotifyArtUrl).toBe("https://i.scdn.test/rainbows");
    expect(done.artwork!.source).toBe("spotify");
    expect(artBytes(s, id)).toBe("spotify-art");
  });

  /**
   * ADR 0059. Curator was already identifying the Spotify album to borrow its cover, then throwing
   * the identity away — so `metadata.spotifyUri` was absent for a whole Discogs-sourced collection
   * and every consumer that streams audio (Amp on a card or demo scan, desk audio, the demo-track
   * picker) saw "not on Spotify" for records Curator could name.
   */
  it("keeps the matched album's URI on an exact match, so it can play", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: spotifyWithMatch(),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.metadata.spotifyUri).toBe("spotify:album:sp1");
    expect(done.metadata.spotifyMatch).toMatchObject({
      confidence: "exact",
      name: "In Rainbows",
      artist: "Radiohead",
      year: 2007,
    });
    expect(done.metadata.spotifyMatch!.matchedAt).toBeTruthy();
  });

  /**
   * The whole point of the two bars: a `close` match is good enough to borrow a cover and **not**
   * good enough to start audio. Here Spotify's title is a superset of the Discogs one — the match
   * qualifies, so the art is used, but nothing may play from it.
   */
  it("lends its cover but no URI on a close match — art and audio are not the same bar", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: fakeSpotify({
        searchAlbums: async () => [
          {
            spotifyId: "sp2",
            spotifyUri: "spotify:album:sp2",
            name: "In Rainbows Disk 2", // a superset title: close, not exact
            artist: "Radiohead",
            year: 2007,
            artUrl: "https://i.scdn.test/disk2",
          },
        ],
        downloadArt: async () => Buffer.from("spotify-art"),
      }),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.metadata.spotifyArtUrl).toBe("https://i.scdn.test/disk2");
    expect(done.metadata.spotifyUri).toBeUndefined();
    expect(done.metadata.spotifyMatch!.confidence).toBe("close");
  });

  /**
   * The **onboarding** path into ambiguity ([ADR 0068](../../../docs/adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md),
   * [#289](https://github.com/dylanleatham/Marquee/issues/289)). The sweep has its own test; this is
   * the one that proves a plain Discogs add reaches the same state, which is what roadie-spec now
   * claims. Both go through `applySpotifyMatch`, but "both callers use the shared helper" is exactly
   * the kind of thing that stays true until someone changes one of them.
   *
   * The cover is the assertion that matters: refusing has to leave the **Discogs** image in place,
   * because that is the one that came off the pressing being added. Weezer's Blue Album wearing the
   * Teal Album's sleeve (#288) is what happens when this goes wrong.
   */
  it("lands on an ambiguity, and keeps the Discogs cover, when a Discogs add has namesakes", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const weezer = (year: number) => ({
      spotifyId: `sp${year}`,
      spotifyUri: `spotify:album:sp${year}`,
      name: "Weezer",
      artist: "Weezer",
      year,
      artUrl: `https://i.scdn.test/${year}`,
    });
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs({
        getRelease: async (releaseId: number) => ({
          releaseId,
          discogsUri: `discogs:release:${releaseId}`,
          title: "Weezer",
          artist: "Weezer",
          year: 2020, // a repress — its year dates the vinyl, not the album
          genres: ["rock"],
          artUrl: "https://img.discogs.test/blue.jpg",
        }),
      }) as DiscogsClient,
      spotify: fakeSpotify({
        searchAlbums: async () => [weezer(1994), weezer(2019)],
        downloadArt: async () => Buffer.from("spotify-art"),
      }),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.metadata.spotifyAmbiguous).toMatchObject({ candidateCount: 2 });
    expect(done.metadata.spotifyAmbiguous!.detectedAt).toBeTruthy();
    // Nothing borrowed from an album it refused to choose.
    expect(done.metadata.spotifyUri).toBeUndefined();
    expect(done.metadata.spotifyArtUrl).toBeUndefined();
    expect(done.metadata.spotifyMatch).toBeUndefined();
    // And the sleeve on the shelf is the one that came with the pressing.
    expect(done.artwork!.source).toBe("discogs");
    expect(artBytes(s, id)).toBe("discogs-art");
  });

  it("records nothing at all when there is no match, so absence stays honest", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: fakeSpotify({ searchAlbums: async () => [] }),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.metadata.spotifyUri).toBeUndefined();
    expect(done.metadata.spotifyMatch).toBeUndefined();
  });

  it("falls back to the Discogs image when Spotify has no confident match", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: fakeSpotify({
        searchAlbums: async () => [
          {
            spotifyId: "wrong",
            spotifyUri: "spotify:album:wrong",
            name: "OK Computer", // different album
            artist: "Radiohead",
            artUrl: "https://i.scdn.test/okc",
          },
        ],
      }),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.metadata.spotifyArtUrl).toBeUndefined();
    expect(done.artwork!.source).toBe("discogs");
    expect(artBytes(s, id)).toBe("discogs-art");
  });

  it("uses the Discogs image when Spotify isn't configured", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, { discogs: fakeDiscogs() }); // no spotify
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.artwork!.source).toBe("discogs");
    expect(artBytes(s, id)).toBe("discogs-art");
  });

  it("never fails the add when the Spotify search errors — keeps the Discogs image", async () => {
    const s = store();
    const id = seedDiscogs(s);
    const roadie = roadieFor(s, {
      discogs: fakeDiscogs(),
      spotify: fakeSpotify({
        searchAlbums: async () => {
          throw new Error("spotify 500");
        },
      }),
    });
    roadie.enqueue(id);
    await roadie.drain();

    const done = s.read(id)!;
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.artwork!.source).toBe("discogs");
  });
});

describe("Roadie retry + failure classification", () => {
  it("retries a transient Spotify error with backoff, then succeeds", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "dddd4444",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:dddd4444",
      },
    });
    s.save(asset);

    let calls = 0;
    const spotify = fakeSpotify({
      getAlbum: (async (id: string) => {
        if (++calls <= 2) throw new SpotifyError("rate limited", 429);
        return {
          spotifyId: id,
          spotifyUri: `spotify:album:${id}`,
          name: "Recovered",
          artist: "A",
          genres: [],
          artUrl: "https://i.scdn.co/image/x",
        };
      }) as SpotifyClient["getAlbum"],
    });
    const slept: number[] = [];
    // rand:()=>0.5 → jitter term is zero → delays are exactly the base schedule.
    const roadie = roadieFor(s, {
      spotify,
      rand: () => 0.5,
      sleep: async (ms) => void slept.push(ms),
    });
    roadie.enqueue("dddd4444");
    await roadie.drain();

    expect(calls).toBe(3); // 2 failures + 1 success
    expect(slept).toHaveLength(2); // backed off twice
    expect(slept[0]).toBe(1000);
    expect(slept[1]).toBe(4000);
    const done = s.read("dddd4444")!;
    expect(done.metadata.name).toBe("Recovered");
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.roadie.retryCount).toBe(0); // reset on success
  });

  it("gives up after the retry schedule is exhausted → errored", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "eeee5555",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:eeee5555",
      },
    });
    s.save(asset);
    const spotify = fakeSpotify({
      getAlbum: (async () => {
        throw new SpotifyError("still down", 503);
      }) as SpotifyClient["getAlbum"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("eeee5555");
    await roadie.drain();

    const done = s.read("eeee5555")!;
    expect(done.roadie.state).toBe("errored");
    expect(done.roadie.lastError?.message).toMatch(/gave up after 4 retries/);
  });

  it("classifies a 404 as needs_manual with a reason (permanent, no retry)", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "ffff6666",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:ffff6666",
      },
    });
    s.save(asset);
    let calls = 0;
    const spotify = fakeSpotify({
      getAlbum: (async () => {
        calls++;
        throw new SpotifyError("not found", 404);
      }) as SpotifyClient["getAlbum"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("ffff6666");
    await roadie.drain();

    expect(calls).toBe(1); // no retries on a permanent failure
    const done = s.read("ffff6666")!;
    expect(done.roadie.state).toBe("needs_manual");
    expect(done.roadie.flags.album_not_on_spotify).toBe(true);
    expect(done.roadie.lastError?.reason).toBe("album_not_on_spotify");
  });

  it("parks an album whose Spotify record has no cover art at needs_manual (art_unavailable)", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "kkkk1234",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:kkkk1234",
      },
    });
    s.save(asset);
    // Metadata fetch succeeds but the album has no artUrl → downloadArt can't proceed.
    const spotify = fakeSpotify({
      getAlbum: (async (id: string) => ({
        spotifyId: id,
        spotifyUri: `spotify:album:${id}`,
        name: "Art-less",
        artist: "A",
        genres: [],
        // no artUrl
      })) as SpotifyClient["getAlbum"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("kkkk1234");
    await roadie.drain();

    const done = s.read("kkkk1234")!;
    expect(done.metadata.name).toBe("Art-less"); // got past fetching_metadata
    expect(done.roadie.state).toBe("needs_manual");
    expect(done.roadie.lastError?.reason).toBe("art_unavailable");
    expect(done.roadie.flags.album_not_on_spotify).toBe(false);
  });

  it("parks an album whose art download 404s at needs_manual (art_unavailable)", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "llll5678",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:llll5678",
      },
    });
    s.save(asset);
    let artCalls = 0;
    const spotify = fakeSpotify({
      downloadArt: (async () => {
        artCalls++;
        throw new SpotifyError("art gone", 404);
      }) as SpotifyClient["downloadArt"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("llll5678");
    await roadie.drain();

    expect(artCalls).toBe(1); // 404 is permanent — no retry
    const done = s.read("llll5678")!;
    expect(done.roadie.state).toBe("needs_manual");
    expect(done.roadie.lastError?.reason).toBe("art_unavailable");
  });

  it("classifies a 401 as errored (config problem, no retry)", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "gggg7777",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:gggg7777",
      },
    });
    s.save(asset);
    const spotify = fakeSpotify({
      getAlbum: (async () => {
        throw new SpotifyError("bad creds", 401);
      }) as SpotifyClient["getAlbum"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("gggg7777");
    await roadie.drain();
    expect(s.read("gggg7777")!.roadie.state).toBe("errored");
  });
});

describe("Roadie controls + resilience", () => {
  it("recover() re-enqueues albums left mid-processing on disk", async () => {
    const s = store();
    const id = seedManual(s, "hhhh8888"); // sits at generating_palette
    const roadie = roadieFor(s);
    roadie.recover();
    await roadie.drain();
    expect(s.read("hhhh8888")!.roadie.state).toBe("awaiting_review");
  });

  it("retry() resets an errored album and re-runs it to completion", async () => {
    const s = store();
    const asset = buildFreshAsset({
      curatorId: "iiii9999",
      metadata: {
        name: "",
        artist: "",
        source: "spotify",
        spotifyUri: "spotify:album:iiii9999",
      },
    });
    s.save(asset);
    let down = true;
    const spotify = fakeSpotify({
      getAlbum: (async (id: string) => {
        if (down) throw new SpotifyError("down", 503);
        return {
          spotifyId: id,
          spotifyUri: `spotify:album:${id}`,
          name: "Back Up",
          artist: "A",
          genres: [],
          artUrl: "https://i.scdn.co/image/x",
        };
      }) as SpotifyClient["getAlbum"],
    });
    const roadie = roadieFor(s, { spotify });
    roadie.enqueue("iiii9999");
    await roadie.drain();
    expect(s.read("iiii9999")!.roadie.state).toBe("errored");

    down = false; // "fix" the outage
    const result = roadie.retry("iiii9999");
    expect(result).toMatchObject({ ok: true, state: "fetching_metadata" });
    await roadie.drain();
    const done = s.read("iiii9999")!;
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.metadata.name).toBe("Back Up");
    expect(done.roadie.retryCount).toBe(0);
  });

  it("pause() stops the worker from picking up new work until resume()", async () => {
    const s = store();
    const id = seedManual(s, "jjjj0000");
    const roadie = roadieFor(s);
    roadie.pause();
    roadie.enqueue(id);
    await roadie.drain(); // nothing runs while paused
    expect(s.read(id)!.roadie.state).toBe("generating_palette");
    expect(roadie.status().queueDepth).toBe(1);

    roadie.resume();
    await roadie.drain();
    expect(s.read(id)!.roadie.state).toBe("awaiting_review");
  });
});
