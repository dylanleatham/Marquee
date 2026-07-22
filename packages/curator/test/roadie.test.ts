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
  it("drives a manual album generating_palette → drafting_prompts → awaiting_review", async () => {
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
      "drafting_prompts",
      "awaiting_review",
    ]);
    expect(asset.promptDrafts!.video!.template).toBe("abstract_flow");
  });

  it("drafts grounded LLM variant sets when a Gemini client is configured", async () => {
    const s = store();
    const id = seedManual(s);
    const variants = Array.from({ length: 5 }, (_, i) => ({
      text: `Variant ${i} grounded in the cover art`,
      nudge: `angle ${i}`,
    }));
    const fg = createFakeGemini({
      research: "cover facts",
      json: { variants },
    });
    const gemini = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    const roadie = roadieFor(s, { gemini });
    roadie.enqueue(id);
    await roadie.drain();

    const drafts = s.read(id)!.promptDrafts!;
    expect(drafts.video!.generator).toBe("gemini");
    expect(drafts.video!.variants).toHaveLength(5);
    expect(drafts.cardArt!.generator).toBe("gemini");
    // One grounded research call + two structured drafting calls (video + card art).
    expect(fg.calls().filter((c) => c.grounded)).toHaveLength(1);
    expect(fg.calls().filter((c) => c.structured)).toHaveLength(2);
  });

  it("falls back to the deterministic templates when the Gemini call fails", async () => {
    const s = store();
    const id = seedManual(s);
    const fg = createFakeGemini({ failStatus: 500 });
    const gemini = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    const roadie = roadieFor(s, { gemini });
    roadie.enqueue(id);
    await roadie.drain();

    // A dead key must not strand the album: it still reaches review, on templates.
    const asset = s.read(id)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.promptDrafts!.video!.generator).toBe("template");
    expect(asset.promptDrafts!.video!.template).toBe("abstract_flow");
  });

  it("drives a Spotify album through fetch → download → palette → prompts", async () => {
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
      "drafting_prompts",
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
