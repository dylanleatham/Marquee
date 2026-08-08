// The Spotify-backfill route and its job hand-off (ADR 0059). The sweep itself is unit-tested in
// spotify-backfill.test.ts; here we cover the route contract — the 202 + job, dedupe on a second
// press, the not-configured path, and the album actually becoming playable end to end.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpotify, type FakeAlbum } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

const SPOTIFY_ID = "1C2h7mLntPSeVYciMRTF4a";

const album: FakeAlbum = {
  id: SPOTIFY_ID,
  name: "In Rainbows",
  artist: { id: "rh", name: "Radiohead" },
  year: 2007,
  genres: ["rock"],
  artwork: Buffer.from("IMG"),
};

function build({ withSpotify = true }: { withSpotify?: boolean } = {}) {
  const store = new AssetStore(
    mkdtempSync(join(tmpdir(), "curator-backfill-routes-")),
  );
  const spotify = withSpotify
    ? new SpotifyClient({
        clientId: "id",
        clientSecret: "secret",
        fetch: createFakeSpotify([album]).fetch,
      })
    : undefined;
  const { app } = buildServer({
    store,
    roadie: fakeRoadie(store),
    prober: fakeProber(),
    ...(spotify ? { spotify } : {}),
  });
  return { app, store };
}

/** A Discogs album on disk with no Spotify identity — what the sweep exists to fix. */
const seed = (store: AssetStore, curatorId: string) => {
  const asset = makeAsset(curatorId, "In Rainbows", "Radiohead");
  asset.metadata = {
    ...asset.metadata,
    source: "discogs",
    discogsReleaseId: 1,
    discogsUri: "discogs:release:1",
    year: 2007,
  };
  asset.roadie.state = "awaiting_review";
  store.save(asset);
};

/** Poll the job until it leaves `running` — the sweep is async behind a 202. */
async function settle(app: ReturnType<typeof build>["app"], jobId: string) {
  for (let i = 0; i < 60; i++) {
    const res = await app.inject({ url: `/api/jobs/${jobId}` });
    const job = res.json();
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job never settled");
}

describe("POST /api/albums/spotify-backfill", () => {
  it("returns 202 + a library-scoped job, and makes the album playable", async () => {
    const { app, store } = build();
    seed(store, "aaaa1111");

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/spotify-backfill",
    });
    expect(res.statusCode).toBe(202);
    const job = res.json();
    expect(job).toMatchObject({ kind: "spotifyBackfill", status: "running" });
    expect(job.curatorId).toBeUndefined(); // library-scoped

    const done = await settle(app, job.id);
    expect(done.status).toBe("done");
    expect(done.result.spotifyBackfill).toMatchObject({ matched: 1 });

    // The point of the whole exercise: Amp and the picker read this field.
    expect(store.read("aaaa1111")!.metadata.spotifyUri).toBe(
      `spotify:album:${SPOTIFY_ID}`,
    );
  });

  it("503s when Spotify isn't configured, rather than starting a job that can't work", async () => {
    const { app, store } = build({ withSpotify: false });
    seed(store, "aaaa1111");

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/spotify-backfill",
    });
    expect(res.statusCode).toBe(503);
    expect(store.read("aaaa1111")!.metadata.spotifyUri).toBeUndefined();
  });

  /**
   * `jobs.start` dedupes library-scoped jobs of a kind — a second press reattaches (ADR 0029).
   *
   * The sweep is held open on a deferred search rather than raced against: with a fake Spotify it
   * finishes in single-digit milliseconds, so "press twice quickly" would pass or fail on timing and
   * prove nothing either way.
   */
  it("reattaches to a run already going instead of starting a second sweep", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const store = new AssetStore(
      mkdtempSync(join(tmpdir(), "curator-backfill-dedupe-")),
    );
    seed(store, "aaaa1111");
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      spotify: {
        searchAlbums: async () => {
          await held;
          return [];
        },
      } as unknown as SpotifyClient,
    });

    const first = (
      await app.inject({ method: "POST", url: "/api/albums/spotify-backfill" })
    ).json();
    const second = (
      await app.inject({ method: "POST", url: "/api/albums/spotify-backfill" })
    ).json();

    expect(first.status).toBe("running");
    expect(second.id).toBe(first.id);

    release();
    await settle(app, first.id);
  });

  it("is listed by GET /api/jobs?kind=spotifyBackfill so a reload can reattach", async () => {
    const { app, store } = build();
    seed(store, "aaaa1111");
    const job = (
      await app.inject({ method: "POST", url: "/api/albums/spotify-backfill" })
    ).json();
    await settle(app, job.id);

    const listed = await app.inject({
      url: "/api/jobs?kind=spotifyBackfill",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs[0]).toMatchObject({ id: job.id });
  });

  it("400s an unknown job kind, naming the ones that exist", async () => {
    const { app } = build();
    const res = await app.inject({ url: "/api/jobs?kind=nonsense" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("spotifyBackfill");
  });
});
