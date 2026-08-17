import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createFakeSpotify } from "@marquee/fake-spotify";
import { AssetStore } from "../src/store/asset-store.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { buildServer } from "../src/server.js";
import {
  addAlbumsBatch,
  regeneratePalettesRunner,
  MAX_BATCH_ADD,
  type BatchAddReport,
} from "../src/albums/batch.js";
import { ValidationError } from "../src/albums/add-manual.js";
import { resolvedArtworkFile } from "../src/albums/artwork.js";
import type { ActionDeps } from "../src/albums/actions.js";
import type { AlbumAsset } from "../src/albums/asset.js";
import {
  fakeRoadie,
  fakeProber,
  fakeGenerate,
  fakePayload,
  makeAsset,
  noAnnounce,
} from "./helpers.js";

const uri = (id: string) => `spotify:album:${id}`;
const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-bat-")));
const spotifyClient = () =>
  new SpotifyClient({
    clientId: "id",
    clientSecret: "s",
    fetch: createFakeSpotify([]).fetch,
  });

/** An album on disk in review, with a real cover file so the sweep has something to extract from. */
function seed(
  s: AssetStore,
  curatorId: string,
  patch: Partial<AlbumAsset> = {},
) {
  const asset = { ...makeAsset(curatorId, curatorId, "Artist"), ...patch };
  s.save(asset);
  const art = resolvedArtworkFile(s, asset);
  mkdirSync(dirname(art), { recursive: true });
  writeFileSync(art, Buffer.from("IMG"));
  return asset;
}

const runner = (
  s: AssetStore,
  opts?: { force?: boolean },
  deps?: Partial<ActionDeps>,
) =>
  regeneratePalettesRunner(
    { store: s, prober: fakeProber(), generate: fakeGenerate, ...deps },
    opts ?? {},
  );

const noopCtx = () => ({
  onProgress: () => {},
  signal: new AbortController().signal,
});

describe("addAlbumsBatch", () => {
  it("reports an outcome per item — added, already present, and junk", async () => {
    const s = store();
    const roadie = fakeRoadie(s);
    const first = await addAlbumsBatch(
      { store: s, roadie, announce: noAnnounce },
      [uri("AAA111")],
    );

    const report = await addAlbumsBatch(
      { store: s, roadie, announce: noAnnounce },
      [
        uri("BBB222"),
        uri("AAA111"), // added by the previous call
        "not-a-uri",
        uri("CCC333"),
      ],
    );

    expect(report.added).toBe(2);
    expect(report.duplicate).toBe(1);
    expect(report.invalid).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.curatorIds).toHaveLength(2);
    // Indices are the submitted positions, so the UI can point at the offending line.
    expect(report.items.map((i) => [i.index, i.status])).toEqual([
      [0, "added"],
      [1, "duplicate"],
      [2, "invalid"],
      [3, "added"],
    ]);
    expect(report.items[1]!.curatorId).toBe(first.curatorIds[0]);
    expect(report.items[2]!.input).toBe("not-a-uri");
  });

  it("catches a line repeated inside the same paste", async () => {
    const s = store();
    const report = await addAlbumsBatch(
      { store: s, roadie: fakeRoadie(s), announce: noAnnounce },
      [uri("DUP999"), uri("DUP999")],
    );
    expect(report.added).toBe(1);
    expect(report.duplicate).toBe(1);
    // The second line points at the album the first line just created, not at nothing.
    expect(report.items[1]!.curatorId).toBe(report.curatorIds[0]);
  });

  it("accepts the documented object form as well as a bare line", async () => {
    const s = store();
    const report = await addAlbumsBatch(
      { store: s, roadie: fakeRoadie(s), announce: noAnnounce },
      [{ mode: "spotify", spotifyUri: uri("OBJ111") }, { spotifyId: "OBJ222" }],
    );
    expect(report.added).toBe(2);
    expect(report.items.map((i) => i.input)).toEqual([
      uri("OBJ111"),
      uri("OBJ222"),
    ]);
  });

  it("rejects a malformed envelope rather than reporting it per item", async () => {
    const s = store();
    const roadie = fakeRoadie(s);
    const deps = { store: s, roadie, announce: noAnnounce };
    await expect(
      addAlbumsBatch(deps, undefined as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(addAlbumsBatch(deps, [])).rejects.toBeInstanceOf(
      ValidationError,
    );
    // The cap is what keeps a paste box from becoming an unbounded loop.
    await expect(
      addAlbumsBatch(deps, Array(MAX_BATCH_ADD + 1).fill(uri("XXX111"))),
    ).rejects.toThrow(/cap is 500/);
  });
});

describe("regeneratePalettesRunner", () => {
  it("re-derives every eligible palette and reports progress as it goes", async () => {
    const s = store();
    seed(s, "aaaaaaa1");
    seed(s, "aaaaaaa2");
    const seen: [number, number][] = [];

    const { paletteBatch } = await runner(s)({
      onProgress: (done, total) => seen.push([done, total]),
      signal: new AbortController().signal,
    });

    expect(paletteBatch.total).toBe(2);
    expect(paletteBatch.regenerated).toBe(2);
    expect(paletteBatch.skipped + paletteBatch.failed).toBe(0);
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(s.read("aaaaaaa1")!.palette!.algorithm).toBe("fake@0");
  });

  it("skips a hand-edited palette, and includes it only with force", async () => {
    const s = store();
    const handEdited = makeAsset("handedit", "Kind of Blue", "Miles Davis");
    handEdited.palette!.handEdited = true;
    handEdited.palette!.algorithm = "by-hand";
    seed(s, "handedit", handEdited);

    const skipped = await runner(s)(noopCtx());
    expect(skipped.paletteBatch.items[0]).toMatchObject({
      curatorId: "handedit",
      label: "Miles Davis — Kind of Blue",
      status: "skipped_hand_edited",
    });
    // The point of skipping: the hand-edit is still there afterwards.
    expect(s.read("handedit")!.palette!.algorithm).toBe("by-hand");

    const forced = await runner(s, { force: true })(noopCtx());
    expect(forced.paletteBatch.regenerated).toBe(1);
    expect(s.read("handedit")!.palette!.handEdited).toBe(false);
  });

  it("skips an album Roadie is mid-pipeline on rather than failing the sweep", async () => {
    const s = store();
    const busy = makeAsset("busyalbm");
    busy.roadie.state = "generating_palette";
    seed(s, "busyalbm", busy);
    seed(s, "freealbm");

    const { paletteBatch } = await runner(s)(noopCtx());
    expect(paletteBatch.regenerated).toBe(1);
    expect(paletteBatch.failed).toBe(0);
    expect(
      paletteBatch.items.find((i) => i.curatorId === "busyalbm")!.status,
    ).toBe("skipped_processing");
  });

  it("skips an album whose cover art is missing from disk", async () => {
    const s = store();
    s.save(makeAsset("noartalb")); // saved without writing the artwork file
    const { paletteBatch } = await runner(s)(noopCtx());
    expect(paletteBatch.items[0]!.status).toBe("skipped_no_art");
    expect(paletteBatch.failed).toBe(0);
  });

  it("records a failure and carries on to the next album", async () => {
    const s = store();
    seed(s, "badcover");
    seed(s, "okcover1");
    let call = 0;
    const generate = async () => {
      if (++call === 1) throw new Error("vibrant blew up");
      return fakePayload();
    };

    const { paletteBatch } = await runner(s, {}, { generate })(noopCtx());
    expect(paletteBatch.failed).toBe(1);
    expect(paletteBatch.regenerated).toBe(1);
    expect(paletteBatch.items[0]).toMatchObject({
      status: "failed",
      error: "vibrant blew up",
    });
  });

  it("stops between albums once cancelled", async () => {
    const s = store();
    for (const id of ["cancel01", "cancel02", "cancel03"]) seed(s, id);
    const controller = new AbortController();
    // Abort while the first album's extraction is in flight; the loop checks between albums, so
    // exactly one completes. Cancellation — not a timeout — is what bounds this sweep (ADR 0029).
    const generate = async () => {
      controller.abort();
      return fakePayload();
    };

    const { paletteBatch } = await runner(
      s,
      {},
      { generate },
    )({
      onProgress: () => {},
      signal: controller.signal,
    });
    expect(paletteBatch.regenerated).toBe(1);
    expect(paletteBatch.items).toHaveLength(1);
    expect(paletteBatch.total).toBe(3); // the report still says how big the job was
  });
});

describe("batch routes", () => {
  const server = (
    s: AssetStore,
    generate: ActionDeps["generate"] = fakeGenerate,
  ) =>
    buildServer({
      store: s,
      roadie: fakeRoadie(s),
      prober: fakeProber(),
      ...(generate ? { generate } : {}),
      spotify: spotifyClient(),
    }).app;

  it("POST /api/albums/batch answers 200 with the per-item report", async () => {
    const s = store();
    const res = await server(s).inject({
      method: "POST",
      url: "/api/albums/batch",
      payload: { items: [uri("RTE111"), "junk", uri("RTE111")] },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as BatchAddReport;
    expect(report).toMatchObject({ added: 1, invalid: 1, duplicate: 1 });
    expect(report.curatorIds).toHaveLength(1);
  });

  it("POST /api/albums/batch 400s on a malformed envelope", async () => {
    const s = store();
    for (const payload of [{}, { items: [] }, { items: "nope" }]) {
      const res = await server(s).inject({
        method: "POST",
        url: "/api/albums/batch",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("regenerate-palettes runs as a library job you can poll and reattach to", async () => {
    const s = store();
    seed(s, "route001");
    const app = server(s);

    const start = await app.inject({
      method: "POST",
      url: "/api/batch/regenerate-palettes",
    });
    expect(start.statusCode).toBe(202);
    // The job *is* the body, as with every other job-starting route.
    const job = start.json() as { id: string; kind: string };
    expect(job.kind).toBe("paletteBatch");
    // Library-scoped: no album owns it (ADR 0029).
    expect(job).not.toHaveProperty("curatorId");

    // Reattach the way the panel does after a reload, before the sweep is necessarily finished.
    const listed = await app.inject({ url: "/api/jobs?kind=paletteBatch" });
    expect(listed.json().jobs.map((j: { id: string }) => j.id)).toEqual([
      job.id,
    ]);

    const finished = await poll(app, job.id);
    expect(finished.status).toBe("done");
    expect(finished.result.paletteBatch.regenerated).toBe(1);
  });

  it("starting a second sweep reattaches to the running one", async () => {
    const s = store();
    seed(s, "route002");
    // Hold the first album's extraction open so the sweep is genuinely mid-flight when the second
    // request lands — otherwise the fake generator finishes before the button is pressed twice, and
    // the test would pass for the wrong reason.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const app = server(s, async () => {
      await held;
      return fakePayload();
    });

    const one = await app.inject({
      method: "POST",
      url: "/api/batch/regenerate-palettes",
    });
    const two = await app.inject({
      method: "POST",
      url: "/api/batch/regenerate-palettes",
    });
    expect(two.json().id).toBe(one.json().id);

    release();
    expect((await poll(app, one.json().id)).status).toBe("done");
  });

  it("GET /api/jobs 400s without a library kind, and never returns per-album jobs", async () => {
    const s = store();
    const app = server(s);
    expect((await app.inject({ url: "/api/jobs" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/jobs?kind=video" })).statusCode).toBe(
      400,
    );
  });

  /**
   * This assertion used to read `expect(503)`, on a server built without `generate` — and it was
   * pinning a bug. `buildServer` gave `actionDeps.generate` no fallback while `Roadie` next to it
   * did, so "built without `generate`" was not an exotic test arrangement: it was **production**
   * ([#319](https://github.com/dylanleatham/Marquee/issues/319)). The 503 this test protected was
   * the answer the shipped app gave every time anyone asked for a sweep.
   *
   * A test can only ever say the code does what it does. What made this one actively harmful is the
   * comment it carried — "the precheck must refuse up front" — which read as a decision someone had
   * made, so the 503 looked intended rather than reported. See `server-wiring.test.ts` for the gate
   * that now covers the whole family.
   */
  it("accepts the sweep on the server production builds", async () => {
    const s = store();
    // Deliberately no `generate`, exactly as the entry point builds it — that is the point.
    const { app } = buildServer({
      store: s,
      roadie: fakeRoadie(s),
      prober: fakeProber(),
      spotify: spotifyClient(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/batch/regenerate-palettes",
    });
    expect(res.statusCode).toBe(202);
  });
});

/**
 * Poll a job to a terminal state, the way the UI does. Bounded by attempts rather than wall-clock so
 * a hang fails with "never finished" instead of a suite-wide timeout.
 */
async function poll(
  app: ReturnType<typeof buildServer>["app"],
  id: string,
  attempts = 100,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${id} never left "running"`);
}
