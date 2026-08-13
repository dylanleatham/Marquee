// The default visualizer (ADR 0073) — the one clip Backdrop plays for every record with no
// visualizer of its own, and the Curator surface for choosing it.
//
// ADR 0073 shipped the runtime half and left the file to `scp` plus a hand-run `ffmpeg`. That made
// the clip that plays *most often* the only one nobody encodes for the hardware, so the property
// these tests care most about is that it goes through the **same ingest as any visualizer** — the
// decode budget included.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { readSettings } from "../src/settings.js";
import {
  DEFAULT_VISUALIZER_FILE_ID,
  defaultVisualizerFile,
  describeDefaultVisualizer,
} from "../src/media/default-visualizer.js";
import {
  makeAsset,
  fakeProber,
  fakeRoadie,
  buildMultipart,
} from "./helpers.js";

const SECRET = "s3cr3t";
let store: AssetStore;
let dataDir: string;
let mediaDir: string;

/** A stub Backdrop that records media uploads and serves a library we can shape per test. */
function stubBackdrop() {
  const media: Record<string, Buffer> = {};
  let entries: Record<string, unknown> = {};
  /** Held open by a test that needs to look at the job while the upload is still in flight. */
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const app = Fastify();
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.put("/api/media/:fileId", async (req) => {
    if (hold) await hold;
    const { fileId } = req.params as { fileId: string };
    media[fileId] = req.body as Buffer;
    return { fileId, bytes: (req.body as Buffer).length };
  });
  app.get("/api/library", async () => ({
    version: 1,
    updatedAt: "now",
    entries,
  }));
  app.post("/api/library/update", async () => ({ updated: true }));
  app.post("/api/library/sync", async () => ({ synced: 0 }));
  return {
    app,
    media,
    setEntries: (e: Record<string, unknown>) => (entries = e),
    /** Make the next upload block until `finish()` — so a test can read the job mid-flight. */
    stall: () => {
      hold = new Promise<void>((r) => (release = r));
    },
    finish: () => {
      release?.();
      hold = undefined;
    },
  };
}

let backdrop: ReturnType<typeof stubBackdrop>;
let url: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "curator-dv-"));
  mediaDir = mkdtempSync(join(tmpdir(), "backdrop-dv-"));
  store = new AssetStore(dataDir);
  backdrop = stubBackdrop();
  await backdrop.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = backdrop.app.server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await backdrop.app.close();
});

/** `mode` mirrors ADR 0038: `local` copies on this box, `push` streams, `none` moves nothing. */
const server = (mode: "local" | "push" | "none" = "push") =>
  buildServer({
    store,
    roadie: fakeRoadie(store),
    prober: fakeProber(),
    config: {
      dataDir,
      backdrop: { url, sharedSecret: SECRET, mediaDir, mediaTransfer: mode },
    },
  }).app;

const upload = (
  app: ReturnType<typeof server>,
  filename = "house-loop.mp4",
) => {
  const mp = buildMultipart(
    {},
    {
      field: "file",
      filename,
      contentType: "video/mp4",
      data: Buffer.from("DEFAULTCLIPBYTES"),
    },
  );
  return app.inject({
    method: "POST",
    url: "/api/settings/default-visualizer",
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
};

/** Wait out the background push job so assertions about the Pi's copy aren't racing it. */
const settle = async (app: ReturnType<typeof server>) => {
  for (let i = 0; i < 60; i++) {
    const jobs = (
      await app.inject({
        method: "GET",
        url: "/api/jobs?kind=defaultVisualizerPush",
      })
    ).json() as { jobs: Array<{ kind: string; status: string }> };
    const push = jobs.jobs ?? [];
    if (push.length && push.every((j) => j.status !== "running")) return jobs;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("default visualizer push never settled");
};

describe("the default visualizer", () => {
  it("reports nothing before anything is uploaded", async () => {
    const res = await server().inject({
      method: "GET",
      url: "/api/settings/default-visualizer",
    });
    expect(res.json()).toMatchObject({
      present: false,
      bytes: null,
      meta: null,
    });
  });

  it("stores an uploaded clip under the reserved fileId and records its description", async () => {
    const app = server();
    const res = await upload(app);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      originalFilename: "house-loop.mp4",
      durationSec: 180,
      resolution: "1920x1080",
    });
    expect(existsSync(defaultVisualizerFile(store.paths))).toBe(true);
    expect(readSettings(dataDir).defaultVisualizer).toMatchObject({
      originalFilename: "house-loop.mp4",
    });
    await settle(app);
  });

  /**
   * The whole reason this route exists rather than an `scp`: DEPLOY.md used to say "nothing encodes
   * it for you" about the one clip that plays more often than any single visualizer.
   */
  it("re-encodes a clip that busts the decode budget, and says that it did", async () => {
    const app = buildServer({
      store,
      roadie: fakeRoadie(store),
      // 4K, over-bitrate, with a dead audio track — three violations (ADR 0040).
      prober: fakeProber({
        width: 3840,
        height: 2160,
        bitRateBps: 20_000_000,
        hasAudio: true,
      }),
      config: { dataDir, backdrop: { url, mediaDir, mediaTransfer: "push" } },
    }).app;

    const res = await upload(app, "huge.mp4");

    expect(res.statusCode).toBe(201);
    expect(res.json().normalized).toBe(true);
    // The stored bytes are the encoder's output, not the upload's.
    expect(readFileSync(defaultVisualizerFile(store.paths), "utf8")).toBe(
      "NORMALIZED",
    );
    await settle(app);
  });

  it("says a budget-conformant clip was not re-encoded", async () => {
    const app = server();
    await upload(app);
    expect(readSettings(dataDir).defaultVisualizer!.normalized).toBe(false);
    await settle(app);
  });

  it("rejects a file whose codec the runtime can't play, and stores nothing", async () => {
    const app = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber({ codec: "vp9" }),
      config: { dataDir, backdrop: { url, mediaDir, mediaTransfer: "push" } },
    }).app;

    const res = await upload(app, "wrong.webm");

    expect(res.statusCode).toBe(422);
    expect(existsSync(defaultVisualizerFile(store.paths))).toBe(false);
    expect(readSettings(dataDir).defaultVisualizer).toBeUndefined();
  });

  it("requires a file", async () => {
    const mp = buildMultipart({});
    const res = await server().inject({
      method: "POST",
      url: "/api/settings/default-visualizer",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(400);
  });

  // ADR 0038's modes, applied to this file. Routed through `MediaTransfer` precisely so a
  // single-machine install copies rather than silently doing nothing.
  it("pushes the clip to Backdrop over HTTP in push mode", async () => {
    const app = server("push");
    await upload(app);
    await settle(app);
    expect(backdrop.media[DEFAULT_VISUALIZER_FILE_ID]?.toString()).toBe(
      "DEFAULTCLIPBYTES",
    );
  });

  it("copies the clip into Backdrop's media dir in local mode", async () => {
    const app = server("local");
    await upload(app);
    await settle(app);
    expect(readFileSync(join(mediaDir, "default.mp4"), "utf8")).toBe(
      "DEFAULTCLIPBYTES",
    );
  });

  it("moves no bytes in none mode, and starts no job claiming it did", async () => {
    const app = server("none");
    const res = await upload(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().transferJobId).toBeUndefined();
    expect(backdrop.media[DEFAULT_VISUALIZER_FILE_ID]).toBeUndefined();
  });

  it("re-pushes on request, for when the clip didn't reach the Pi", async () => {
    const app = server();
    await upload(app);
    await settle(app);
    delete backdrop.media[DEFAULT_VISUALIZER_FILE_ID];

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/default-visualizer/push",
    });

    expect(res.statusCode).toBe(202);
    await settle(app);
    expect(backdrop.media[DEFAULT_VISUALIZER_FILE_ID]).toBeDefined();
  });

  it("refuses to push a clip that was never uploaded", async () => {
    const res = await server().inject({
      method: "POST",
      url: "/api/settings/default-visualizer/push",
    });
    expect(res.statusCode).toBe(409);
  });

  // The other 409, and a different problem with a different answer: the clip is here, but Curator
  // is not the thing that moves files in this deployment. Starting a job would claim otherwise.
  it("refuses to push when media transfer is off, and says to copy it yourself", async () => {
    const app = server("none");
    await upload(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/default-visualizer/push",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/copy the file to the Pi yourself/);
  });

  /**
   * Issue #268, in its new home. `onProgress` counts items and `onTransfer` counts bytes; routing
   * bytes into the wrong one is what made a running sync report `24248819/998`. Asserting the job
   * *while it is running* is the only way to see which channel they went down — once it finishes,
   * both are cleared and the bug is invisible.
   */
  it("reports the transfer in bytes, not as item progress", async () => {
    const app = server("push");
    backdrop.stall();
    await upload(app, "big-loop.mp4");

    let job: {
      progress: { done: number; total: number };
      transfer?: { label: string; sent: number; total: number };
    } | null = null;
    for (let i = 0; i < 60 && !job?.transfer; i++) {
      const jobs = (
        await app.inject({
          method: "GET",
          url: "/api/jobs?kind=defaultVisualizerPush",
        })
      ).json().jobs as Array<typeof job>;
      job = jobs?.[0] ?? null;
      if (!job?.transfer) await new Promise((r) => setTimeout(r, 25));
    }

    expect(job?.transfer).toMatchObject({ label: "big-loop.mp4" });
    expect(job!.transfer!.total).toBe("DEFAULTCLIPBYTES".length);
    // The album counter is untouched — there is one file, so it has nothing to count.
    expect(job?.progress).toEqual({ done: 0, total: 0 });

    backdrop.finish();
    await settle(app);
  });

  it("clears the in-flight transfer once the send ends", async () => {
    const app = server("push");
    await upload(app);
    await settle(app);
    const jobs = (
      await app.inject({
        method: "GET",
        url: "/api/jobs?kind=defaultVisualizerPush",
      })
    ).json().jobs as Array<{ transfer?: unknown; status: string }>;
    // A finished transfer that left its last byte count on screen would read as still running.
    expect(jobs[0]!.status).toBe("done");
    expect(jobs[0]!.transfer).toBeUndefined();
  });

  it("streams the clip and its poster for the Settings preview", async () => {
    const app = server();
    await upload(app);
    await settle(app);

    const video = await app.inject({
      method: "GET",
      url: "/api/settings/default-visualizer/video",
    });
    expect(video.statusCode).toBe(200);
    expect(video.headers["content-type"]).toBe("video/mp4");

    const thumb = await app.inject({
      method: "GET",
      url: "/api/settings/default-visualizer/thumbnail",
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
  });

  it("404s the preview before anything is uploaded, rather than erroring", async () => {
    const res = await server().inject({
      method: "GET",
      url: "/api/settings/default-visualizer/video",
    });
    expect(res.statusCode).toBe(404);
  });

  it("forgets the clip on delete, and says the Pi may still be playing it", async () => {
    const app = server();
    await upload(app);
    await settle(app);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/settings/default-visualizer",
    });

    expect(res.json().removed).toBe(true);
    expect(existsSync(defaultVisualizerFile(store.paths))).toBe(false);
    expect(readSettings(dataDir).defaultVisualizer).toBeUndefined();
    // Curator never deletes remote media, so the Pi's copy is untouched and the answer says so.
    expect(backdrop.media[DEFAULT_VISUALIZER_FILE_ID]).toBeDefined();
  });

  /**
   * Three answers, never two (ADR 0072). A `usesDefault` entry's `fileMissing` is Backdrop's own
   * judgement of whether its default clip is playable, so it answers for the whole library.
   */
  describe("whether the Pi has it", () => {
    const ask = async (app: ReturnType<typeof server>) =>
      (
        await app.inject({
          method: "GET",
          url: "/api/settings/default-visualizer",
        })
      ).json().onBackdrop;

    it("reads a playable usesDefault entry as present", async () => {
      backdrop.setEntries({
        "curator:album:aaaa1111": { usesDefault: true, fileMissing: false },
      });
      expect(await ask(server())).toBe("present");
    });

    it("reads an unplayable usesDefault entry as absent", async () => {
      backdrop.setEntries({
        "curator:album:aaaa1111": { usesDefault: true, fileMissing: true },
      });
      expect(await ask(server())).toBe("absent");
    });

    /**
     * A Backdrop too old to derive `fileMissing` can't vouch for the bytes, and that is not a
     * confirmation either way — the same rule ADR 0072 applies to an album's clip. A distinct code
     * path from "no usesDefault entries", so it gets its own case rather than sharing one.
     */
    it("says unknown when the entry omits fileMissing", async () => {
      backdrop.setEntries({ "curator:album:aaaa1111": { usesDefault: true } });
      expect(await ask(server())).toBe("unknown");
    });

    // Nothing on the Pi is in a position to report on the default clip — that is not "absent".
    it("says unknown when no record uses the default", async () => {
      backdrop.setEntries({
        "curator:album:aaaa1111": { filePath: "/m/a.mp4", fileMissing: false },
      });
      expect(await ask(server())).toBe("unknown");
    });

    it("says unknown when Backdrop can't be reached", async () => {
      const app = buildServer({
        store,
        roadie: fakeRoadie(store),
        prober: fakeProber(),
        config: {
          dataDir,
          backdrop: { url: "http://127.0.0.1:1", mediaDir },
        },
      }).app;
      expect(await ask(app)).toBe("unknown");
    });
  });

  describe("describeDefaultVisualizer", () => {
    // The two halves can disagree in both directions, and each means something different.
    it("reports a clip deleted out from under Curator as absent, whatever settings say", () => {
      const status = describeDefaultVisualizer(store.paths, {
        defaultVisualizer: {
          originalFilename: "gone.mp4",
          durationSec: 10,
          resolution: "1920x1080",
          uploadedAt: "2026-08-12T00:00:00.000Z",
          normalized: false,
        },
      });
      expect(status.present).toBe(false);
      expect(status.meta).not.toBeNull(); // …but we still know what it was
    });

    it("reports a hand-dropped clip as present even with no recorded description", () => {
      mkdirSync(store.paths.visualizers, { recursive: true });
      writeFileSync(defaultVisualizerFile(store.paths), "HANDPLACED");
      const status = describeDefaultVisualizer(store.paths, {});
      expect(status.present).toBe(true);
      expect(status.bytes).toBe(10);
      expect(status.meta).toBeNull();
    });
  });

  // The reserved id is only safe because no album can ever claim it.
  it("uses a fileId no curatorId can collide with", () => {
    expect(DEFAULT_VISUALIZER_FILE_ID).not.toMatch(/^[a-z0-9]{8}$/);
    expect(makeAsset("aaaa1111").curatorId).not.toBe(
      DEFAULT_VISUALIZER_FILE_ID,
    );
  });
});
