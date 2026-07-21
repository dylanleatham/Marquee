import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDiscogs, type FakeRelease } from "@marquee/fake-discogs";
import { AssetStore } from "../src/store/asset-store.js";
import { DiscogsClient } from "../src/discogs/client.js";
import { addDiscogsAlbum } from "../src/albums/add-discogs.js";
import { DuplicateAlbumError } from "../src/albums/add-spotify.js";
import { ValidationError } from "../src/albums/add-manual.js";
import { fakeRoadie } from "./helpers.js";

const RELEASE_ID = 249504;
const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-dg-")));
const release = (artwork = Buffer.from("IMG")): FakeRelease => ({
  id: RELEASE_ID,
  title: "Purple Rain",
  artist: "Prince And The Revolution",
  year: 1984,
  genres: ["Funk / Soul"],
  styles: ["Synth-pop"],
  artwork,
});
const client = (fd: ReturnType<typeof createFakeDiscogs>) =>
  new DiscogsClient({ token: "fake-discogs-token", fetch: fd.fetch });

describe("addDiscogsAlbum", () => {
  it("queues a fresh discogs asset, then Roadie fetches metadata + art + palette", async () => {
    const fd = createFakeDiscogs([release()]);
    const s = store();
    const roadie = fakeRoadie(s, { discogs: client(fd) });
    const { curatorId, asset } = await addDiscogsAlbum(
      { store: s, roadie },
      { releaseId: RELEASE_ID, title: "Purple Rain", artist: "Prince" },
    );

    // Queued immediately — the full release detail arrives during processing.
    expect(asset.roadie.state).toBe("fetching_metadata");
    expect(asset.metadata.source).toBe("discogs");
    expect(asset.metadata.discogsUri).toBe(`discogs:release:${RELEASE_ID}`);

    await roadie.drain();

    const done = s.read(curatorId)!;
    expect(done.metadata).toMatchObject({
      source: "discogs",
      name: "Purple Rain",
      artist: "Prince And The Revolution",
      year: 1984,
      discogsReleaseId: RELEASE_ID,
    });
    // Genres come merged from genres + styles.
    expect(done.metadata.genres).toEqual(["Funk / Soul", "Synth-pop"]);
    // Art was downloaded to disk and a palette generated.
    expect(existsSync(s.paths.artworkFile(curatorId))).toBe(true);
    expect(done.palette?.colors.length).toBeGreaterThan(0);
    expect(done.roadie.state).toBe("awaiting_review");
  });

  it("dedupes on the Discogs release id (409)", async () => {
    const fd = createFakeDiscogs([release()]);
    const s = store();
    const roadie = fakeRoadie(s, { discogs: client(fd) });
    await addDiscogsAlbum({ store: s, roadie }, { releaseId: RELEASE_ID });
    await roadie.drain();

    await expect(
      addDiscogsAlbum({ store: s, roadie }, { releaseId: RELEASE_ID }),
    ).rejects.toBeInstanceOf(DuplicateAlbumError);
  });

  it("rejects a missing/invalid releaseId", async () => {
    const s = store();
    const roadie = fakeRoadie(s, { discogs: client(createFakeDiscogs()) });
    await expect(
      addDiscogsAlbum({ store: s, roadie }, {
        releaseId: 0,
      } as { releaseId: number }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not dedupe a Discogs album against a Spotify album of the same title", async () => {
    // Per-source dedupe (ADR 0016): a Spotify + Discogs pair of the same record can coexist.
    const fd = createFakeDiscogs([release()]);
    const s = store();
    const roadie = fakeRoadie(s, { discogs: client(fd) });
    const { curatorId } = await addDiscogsAlbum(
      { store: s, roadie },
      { releaseId: RELEASE_ID },
    );
    // A different-source album with no discogsUri must not collide.
    expect(s.findByDiscogsUri("discogs:release:000")).toBeNull();
    expect(s.findByDiscogsUri(`discogs:release:${RELEASE_ID}`)?.curatorId).toBe(
      curatorId,
    );
  });
});
