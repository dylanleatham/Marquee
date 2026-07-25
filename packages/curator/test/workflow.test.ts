import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import {
  fakeGenerate,
  fakeRoadie,
  fakeProber,
  buildMultipart,
  pngBytes,
} from "./helpers.js";
import { activePromptText, type DraftedPrompt } from "../src/roadie/prompts.js";
import { GeminiClient } from "../src/gemini/client.js";
import { createFakeGemini } from "@marquee/fake-gemini";

/** Build a server with fake Roadie + prober, and add one manual album already at awaiting_review. */
async function serverWithReviewedAlbum(
  proberOpts?: Parameters<typeof fakeProber>[0],
) {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-wf-")));
  const roadie = fakeRoadie(store);
  const { app } = buildServer({
    store,
    roadie,
    prober: fakeProber(proberOpts),
  });
  const mp = buildMultipart(
    { name: "Purple Rain", artist: "Prince" },
    {
      field: "artwork",
      filename: "a.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("IMG"),
    },
  );
  const add = await app.inject({
    method: "POST",
    url: "/api/albums",
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
  const { curatorId } = add.json();
  await roadie.drain();
  return { app, store, curatorId };
}

const post = (
  app: Awaited<ReturnType<typeof serverWithReviewedAlbum>>["app"],
  url: string,
  body?: unknown,
) => app.inject({ method: "POST", url, ...(body ? { payload: body } : {}) });

/**
 * Generation runs as a background job (issue #30 / ADR 0018): the generate routes return 202
 * `{ jobId }`. Poll `GET /api/jobs/:id` until the job leaves `running`, then return its final shape.
 */
async function pollJob(app: any, jobId: string, tries = 50): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const res = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const job = res.json();
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${jobId} still running after ${tries} polls`);
}

const uploadVideo = (
  app: any,
  curatorId: string,
  data = Buffer.from("VIDEOBYTES"),
) => {
  const mp = buildMultipart(
    { curatorId },
    { field: "file", filename: "clip.mp4", contentType: "video/mp4", data },
  );
  return app.inject({
    method: "POST",
    url: "/api/videos/upload",
    headers: { "content-type": mp.contentType },
    payload: mp.body,
  });
};

describe("onboarding workflow", () => {
  it("walks review → video → preview → tag_write", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_review");

    // Draft the video prompt on request (ADR 0027) — onboarding no longer pre-computes it.
    const drafted = await post(
      app,
      `/api/albums/${curatorId}/prompts/video/draft`,
    );
    expect(drafted.statusCode).toBe(200);

    // Copy the video prompt → awaiting_video.
    const copied = await post(
      app,
      `/api/albums/${curatorId}/prompts/video/copied`,
    );
    expect(copied.json().state).toBe("awaiting_video");
    expect(store.read(curatorId)!.promptDrafts!.video!.copiedAt).toBeTruthy();

    // Upload + attach the video → awaiting_preview.
    const up = await uploadVideo(app, curatorId);
    expect(up.statusCode).toBe(201);
    expect(up.json().state).toBe("awaiting_preview");
    const withVideo = store.read(curatorId)!;
    expect(withVideo.visualizer).toMatchObject({
      resolution: "1920x1080",
      loopStrategy: "loop",
    });

    // The video streams back.
    const vid = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video`,
    });
    expect(vid.statusCode).toBe(200);
    expect(vid.headers["content-type"]).toContain("video/mp4");

    // Approve preview → awaiting_tag_write, with a timestamp recorded.
    const approve = await post(app, `/api/albums/${curatorId}/preview/approve`);
    expect(approve.json().state).toBe("awaiting_tag_write");
    expect(store.read(curatorId)!.verification!.previewApprovedAt).toBeTruthy();
  });

  // Issue #55: the last human step — mark the stickers written, then verify → verified.
  it("writes the sleeve/card tags then verifies (step 11)", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    await uploadVideo(app, curatorId);
    await post(app, `/api/albums/${curatorId}/preview/approve`);
    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_tag_write");

    // The card is independent bookkeeping — marking it does not advance the workflow.
    const card = await post(app, `/api/albums/${curatorId}/tag-written`, {
      object: "card",
    });
    expect(card.json().state).toBe("awaiting_tag_write");
    expect(store.read(curatorId)!.tag!.card!.written).toBe(true);

    // The sleeve is scanned on the stand — writing it advances to awaiting_verify.
    const sleeve = await post(app, `/api/albums/${curatorId}/tag-written`, {
      object: "sleeve",
    });
    expect(sleeve.json().state).toBe("awaiting_verify");
    const tagged = store.read(curatorId)!;
    expect(tagged.tag!.sleeve!.written).toBe(true);
    expect(tagged.tag!.payload).toBe(`curator:album:${curatorId}`);

    // Verify → verified, with the physical-verification timestamp recorded.
    const verify = await post(app, `/api/albums/${curatorId}/verify-physical`);
    expect(verify.json().state).toBe("verified");
    const done = store.read(curatorId)!;
    expect(done.roadie.state).toBe("verified");
    expect(done.verification!.physicallyVerifiedAt).toBeTruthy();
  });

  it("won't verify before the sleeve tag advances the album to awaiting_verify", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum();
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    await uploadVideo(app, curatorId);
    await post(app, `/api/albums/${curatorId}/preview/approve`); // awaiting_tag_write
    const res = await post(app, `/api/albums/${curatorId}/verify-physical`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400); // TransitionError, not verified
  });

  it("400s a tag-written call with an invalid object", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum();
    const res = await post(app, `/api/albums/${curatorId}/tag-written`, {
      object: "bogus",
    });
    expect(res.statusCode).toBe(400);
  });

  it("'Something's off' steps back from preview, and detach steps back from preview to video", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    await uploadVideo(app, curatorId);
    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_preview");

    // Reject → back to review.
    const reject = await post(app, `/api/albums/${curatorId}/preview/reject`, {
      to: "awaiting_review",
    });
    expect(reject.json().state).toBe("awaiting_review");

    // Re-advance and detach → back to awaiting_video, visualizer cleared.
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    await uploadVideo(app, curatorId);
    const detach = await post(
      app,
      `/api/albums/${curatorId}/detach-video?delete=1`,
    );
    expect(detach.json().state).toBe("awaiting_video");
    expect(store.read(curatorId)!.visualizer).toBeUndefined();
  });

  it("redrafts a prompt with a chosen template", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const res = await post(
      app,
      `/api/albums/${curatorId}/prompts/video/redraft`,
      {
        template: "psychedelic",
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().promptDrafts.video.template).toBe("psychedelic");
    expect(
      activePromptText(store.read(curatorId)!.promptDrafts!.video!),
    ).toContain("Kaleidoscopic");
  });

  it("attaches and serves card art independently of the state machine", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const mp = buildMultipart(
      { curatorId },
      {
        field: "file",
        filename: "card.png",
        contentType: "image/png",
        data: pngBytes(1050, 600),
      },
    );
    const up = await app.inject({
      method: "POST",
      url: "/api/card-art/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(up.statusCode).toBe(201);
    expect(store.read(curatorId)!.cardArt).toMatchObject({
      ext: "png",
      orientation: "landscape",
    });
    // State is unchanged — card art can be added anytime.
    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_review");

    const art = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/card-art`,
    });
    expect(art.statusCode).toBe(200);
    expect(art.headers["content-type"]).toContain("image/png");
  });
});

// Issue #11: you may already have the video in hand. Attaching one must not require first
// announcing you copied the prompt — that gate only made sense when the prompt was the only way
// to get a video. Both attach entry points (upload, /incoming/ claim) share the gate.
describe("video attach from awaiting_review (issue #11)", () => {
  it("attaches an uploaded video straight from awaiting_review", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_review");

    const up = await uploadVideo(app, curatorId);
    expect(up.statusCode).toBe(201);
    expect(up.json().state).toBe("awaiting_preview");
    expect(store.read(curatorId)!.visualizer).toMatchObject({
      resolution: "1920x1080",
    });
  });

  it("claims an /incoming/ video straight from awaiting_review", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const mp = buildMultipart(
      {},
      {
        field: "file",
        filename: "clip.mp4",
        contentType: "video/mp4",
        data: Buffer.from("VID"),
      },
    );
    const stash = await app.inject({
      method: "POST",
      url: "/api/videos/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    const name = stash.json().incoming;

    expect(store.read(curatorId)!.roadie.state).toBe("awaiting_review");
    const attach = await post(app, `/api/albums/${curatorId}/attach-video`, {
      fileId: name,
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json().state).toBe("awaiting_preview");
  });
});

describe("incoming claim flow", () => {
  it("stashes a video in /incoming/, lists it, and attaches it by fileId", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`); // → awaiting_video

    // Upload with no curatorId → lands in /incoming/.
    const mp = buildMultipart(
      {},
      {
        field: "file",
        filename: "clip.mp4",
        contentType: "video/mp4",
        data: Buffer.from("VID"),
      },
    );
    const up = await app.inject({
      method: "POST",
      url: "/api/videos/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(up.statusCode).toBe(201);
    const name = up.json().incoming;

    const list = await app.inject({ method: "GET", url: "/api/incoming" });
    expect(list.json().files.map((f: { name: string }) => f.name)).toContain(
      name,
    );

    const attach = await post(app, `/api/albums/${curatorId}/attach-video`, {
      fileId: name,
    });
    expect(attach.json().state).toBe("awaiting_preview");
    expect(store.read(curatorId)!.visualizer).toBeTruthy();
    // The claimed file was moved out of /incoming/.
    const after = await app.inject({ method: "GET", url: "/api/incoming" });
    expect(after.json().files).toHaveLength(0);
  });

  it("stashes card art in /incoming/, attaches it by fileId, then detaches", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const mp = buildMultipart(
      {},
      {
        field: "file",
        filename: "card.png",
        contentType: "image/png",
        data: pngBytes(1050, 600),
      },
    );
    const up = await app.inject({
      method: "POST",
      url: "/api/card-art/upload",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    const name = up.json().incoming;

    const attach = await post(app, `/api/albums/${curatorId}/attach-card-art`, {
      fileId: name,
    });
    expect(attach.statusCode).toBe(200);
    expect(store.read(curatorId)!.cardArt).toMatchObject({ ext: "png" });

    const detach = await post(
      app,
      `/api/albums/${curatorId}/detach-card-art?delete=1`,
    );
    expect(detach.statusCode).toBe(200);
    expect(store.read(curatorId)!.cardArt).toBeUndefined();
  });

  it("404s claiming an incoming file that doesn't exist", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum();
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    const res = await post(app, `/api/albums/${curatorId}/attach-video`, {
      fileId: "ghost.mp4",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("workflow guards", () => {
  // Attaching from awaiting_review is legal as of #11, so the guard now bites where it should:
  // an album still in Roadie's pipeline has no palette or prompts yet — a video is premature.
  it("409s attaching a video to an album Roadie hasn't finished yet", async () => {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const asset = store.read(curatorId)!;
    asset.roadie.state = "generating_palette";
    store.save(asset);

    const res = await uploadVideo(app, curatorId);
    expect(res.statusCode).toBe(409);
  });

  it("422s a video whose codec/container isn't allowed", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum({
      container: "matroska,webm",
    });
    await post(app, `/api/albums/${curatorId}/prompts/video/copied`);
    const res = await uploadVideo(app, curatorId);
    expect(res.statusCode).toBe(422);
  });

  it("404s actions on an unknown album", async () => {
    const { app } = await serverWithReviewedAlbum();
    expect(
      (await post(app, `/api/albums/zzzzzzzz/preview/approve`)).statusCode,
    ).toBe(404);
  });
});

describe("card-art generation (routes)", () => {
  /** A server + album at review w/ a 3-variant card prompt. `gemini`: "ok"/"fail" enabled, "disabled" keyed-but-off, "none" no key. */
  async function serverWithCardPrompt(
    gemini: "ok" | "fail" | "disabled" | "none" = "ok",
  ) {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-ca-")));
    const roadie = fakeRoadie(store);
    const fg =
      gemini === "fail"
        ? createFakeGemini({ failStatus: 500 })
        : createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    const { app } = buildServer({
      store,
      roadie,
      prober: fakeProber(),
      generate: fakeGenerate,
      generateCardArt: gemini !== "disabled", // opt-in; "disabled" leaves it off
      ...(gemini !== "none"
        ? { gemini: new GeminiClient({ apiKey: "k", fetch: fg.fetch }) }
        : {}),
    });
    const mp = buildMultipart(
      { name: "Purple Rain", artist: "Prince" },
      {
        field: "artwork",
        filename: "a.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("IMG"),
      },
    );
    const add = await app.inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    const { curatorId } = add.json();
    await roadie.drain();
    // Give it a 3-variant card-art prompt (the fake Roadie has no Gemini, so it drafted a template).
    const asset = store.read(curatorId)!;
    const draft: DraftedPrompt = {
      variants: [0, 1, 2].map((i) => ({ text: `p${i}`, nudge: `look ${i}` })),
      selectedIndex: 0,
      generator: "gemini",
      generatedAt: "2026-07-18T00:00:00.000Z",
    };
    asset.promptDrafts = { ...asset.promptDrafts, cardArt: draft };
    store.save(asset);
    return { app, store, curatorId };
  }

  it("generates candidates, serves them, and promotes the chosen one", async () => {
    const { app, curatorId } = await serverWithCardPrompt();

    const gen = await post(app, `/api/albums/${curatorId}/card-art/generate`);
    expect(gen.statusCode).toBe(202);
    const job = await pollJob(app, gen.json().id);
    expect(job.status).toBe("done");
    expect(job.result.cardArtCandidates).toHaveLength(3);
    expect(job.progress).toEqual({ done: 3, total: 3 });

    // Each candidate image serves.
    const img = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/card-art/candidate/1`,
    });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");

    // Promote candidate 1 → it becomes the attached card art.
    const sel = await post(app, `/api/albums/${curatorId}/card-art/select`, {
      index: 1,
    });
    expect(sel.statusCode).toBe(200);
    expect(sel.json().cardArt.originalFilename).toContain("look 1");
    const card = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/card-art`,
    });
    expect(card.statusCode).toBe(200);
  });

  it("404s a candidate that doesn't exist", async () => {
    const { app, curatorId } = await serverWithCardPrompt();
    const res = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/card-art/candidate/7`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s generate when Gemini isn't configured", async () => {
    const { app, curatorId } = await serverWithCardPrompt("none");
    const res = await post(app, `/api/albums/${curatorId}/card-art/generate`);
    expect(res.statusCode).toBe(400);
  });

  it("400s generate when generation is toggled off (opt-in)", async () => {
    const { app, curatorId } = await serverWithCardPrompt("disabled");
    const res = await post(app, `/api/albums/${curatorId}/card-art/generate`);
    expect(res.statusCode).toBe(400);
  });

  it("fails the job when every image fails (upstream fault, not a 4xx)", async () => {
    // The precheck passes (Gemini keyed + enabled + prompt drafted), so the route still 202s; the
    // whole-batch upstream failure surfaces as a failed job, not a 4xx (issue #30 / ADR 0018).
    const { app, curatorId } = await serverWithCardPrompt("fail");
    const gen = await post(app, `/api/albums/${curatorId}/card-art/generate`);
    expect(gen.statusCode).toBe(202);
    const job = await pollJob(app, gen.json().id);
    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
  });

  // Per-prompt generation (ADR 0021): one image from one prompt, synchronously, into the same set.
  it("generates a single candidate from one prompt and serves it", async () => {
    const { app, curatorId } = await serverWithCardPrompt();
    const gen = await post(app, `/api/albums/${curatorId}/card-art/generate/2`);
    expect(gen.statusCode).toBe(200);
    expect(gen.json().cardArtCandidates).toHaveLength(1);
    expect(gen.json().cardArtCandidates[0]).toMatchObject({ index: 2 });
    const img = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/card-art/candidate/2`,
    });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
  });

  it("400s a per-prompt generate for an out-of-range index", async () => {
    const { app, curatorId } = await serverWithCardPrompt();
    const res = await post(app, `/api/albums/${curatorId}/card-art/generate/9`);
    expect(res.statusCode).toBe(400);
  });

  it("400s a per-prompt generate when generation is off (opt-in)", async () => {
    const { app, curatorId } = await serverWithCardPrompt("disabled");
    const res = await post(app, `/api/albums/${curatorId}/card-art/generate/0`);
    expect(res.statusCode).toBe(400);
  });
});

describe("video generation (routes)", () => {
  /** A server + album at review w/ a 3-variant video prompt. `gemini`: "ok"/"fail" enabled, "disabled" keyed-but-off, "none" no key. */
  async function serverWithVideoPrompt(
    gemini: "ok" | "fail" | "disabled" | "none" = "ok",
  ) {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-vg-")));
    const roadie = fakeRoadie(store);
    const fg =
      gemini === "fail"
        ? createFakeGemini({ failStatus: 500 })
        : createFakeGemini({ videoBytes: "MP4" });
    const { app } = buildServer({
      store,
      roadie,
      prober: fakeProber(),
      generate: fakeGenerate,
      generateVideo: gemini !== "disabled", // opt-in; "disabled" leaves it off
      ...(gemini !== "none"
        ? {
            gemini: new GeminiClient({
              apiKey: "k",
              fetch: fg.fetch,
              sleep: async () => {},
            }),
          }
        : {}),
    });
    const mp = buildMultipart(
      { name: "Purple Rain", artist: "Prince" },
      {
        field: "artwork",
        filename: "a.jpg",
        contentType: "image/jpeg",
        data: Buffer.from("IMG"),
      },
    );
    const add = await app.inject({
      method: "POST",
      url: "/api/albums",
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    const { curatorId } = add.json();
    await roadie.drain();
    const asset = store.read(curatorId)!;
    const draft: DraftedPrompt = {
      variants: [0, 1, 2].map((i) => ({ text: `p${i}`, nudge: `motion ${i}` })),
      selectedIndex: 0,
      generator: "gemini",
      generatedAt: "2026-07-18T00:00:00.000Z",
    };
    asset.promptDrafts = { ...asset.promptDrafts, video: draft };
    store.save(asset);
    return { app, store, curatorId };
  }

  it("generates clips and serves each clip + its thumbnail", async () => {
    const { app, curatorId } = await serverWithVideoPrompt();

    const gen = await post(app, `/api/albums/${curatorId}/video/generate`);
    expect(gen.statusCode).toBe(202);
    const job = await pollJob(app, gen.json().id);
    expect(job.status).toBe("done");
    expect(job.result.videoClips).toHaveLength(3);
    expect(job.progress).toEqual({ done: 3, total: 3 });

    const clip = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video/clip/1`,
    });
    expect(clip.statusCode).toBe(200);
    expect(clip.headers["content-type"]).toContain("video/mp4");

    const thumb = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video/clip/1/thumbnail`,
    });
    expect(thumb.statusCode).toBe(200);

    // The download variant sets a filename.
    const dl = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video/clip/1?download=1`,
    });
    expect(dl.headers["content-disposition"]).toContain("clip-1.mp4");
  });

  it("404s a clip that doesn't exist", async () => {
    const { app, curatorId } = await serverWithVideoPrompt();
    const res = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video/clip/9`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists an album's jobs so the UI can re-attach after a reload (issue #30)", async () => {
    const { app, curatorId } = await serverWithVideoPrompt();
    const gen = await post(app, `/api/albums/${curatorId}/video/generate`);
    const { id } = gen.json();
    const list = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/jobs?kind=video`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs.map((j: { id: string }) => j.id)).toContain(id);
    await pollJob(app, id); // let it finish so no timer leaks past the test
  });

  it("404s an unknown job id", async () => {
    const { app } = await serverWithVideoPrompt();
    const res = await app.inject({ method: "GET", url: `/api/jobs/nope` });
    expect(res.statusCode).toBe(404);
  });

  it("400s generate when Gemini isn't configured", async () => {
    const { app, curatorId } = await serverWithVideoPrompt("none");
    const res = await post(app, `/api/albums/${curatorId}/video/generate`);
    expect(res.statusCode).toBe(400);
  });

  it("400s generate when generation is toggled off (opt-in)", async () => {
    const { app, curatorId } = await serverWithVideoPrompt("disabled");
    const res = await post(app, `/api/albums/${curatorId}/video/generate`);
    expect(res.statusCode).toBe(400);
  });

  it("fails the job when every clip fails (upstream fault)", async () => {
    // Precheck passes → 202; the whole-batch failure lands on the job, not the HTTP status (#30).
    const { app, curatorId } = await serverWithVideoPrompt("fail");
    const gen = await post(app, `/api/albums/${curatorId}/video/generate`);
    expect(gen.statusCode).toBe(202);
    const job = await pollJob(app, gen.json().id);
    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
  });

  // Per-prompt clip generation (ADR 0022): one clip from one prompt, its own index-keyed job.
  it("generates a single clip from one prompt (background job keyed on the index)", async () => {
    const { app, curatorId } = await serverWithVideoPrompt();
    const gen = await post(app, `/api/albums/${curatorId}/video/generate/2`);
    expect(gen.statusCode).toBe(202);
    expect(gen.json().index).toBe(2);
    const job = await pollJob(app, gen.json().id);
    expect(job.status).toBe("done");
    expect(job.result.videoClips).toHaveLength(1);
    expect(job.result.videoClips[0].index).toBe(2);
    const clip = await app.inject({
      method: "GET",
      url: `/api/albums/${curatorId}/video/clip/2`,
    });
    expect(clip.statusCode).toBe(200);
  });

  it("400s a per-prompt clip generate for an out-of-range index", async () => {
    const { app, curatorId } = await serverWithVideoPrompt();
    const res = await post(app, `/api/albums/${curatorId}/video/generate/9`);
    expect(res.statusCode).toBe(400);
  });

  it("400s a per-prompt clip generate when generation is off (opt-in)", async () => {
    const { app, curatorId } = await serverWithVideoPrompt("disabled");
    const res = await post(app, `/api/albums/${curatorId}/video/generate/0`);
    expect(res.statusCode).toBe(400);
  });
});

describe("video splice (routes) — issue #29", () => {
  /** A reviewed album seeded with `n` generated clips + their files on disk. */
  async function serverWithClips(n = 3) {
    const { app, store, curatorId } = await serverWithReviewedAlbum();
    const asset = store.read(curatorId)!;
    asset.videoClips = Array.from({ length: n }, (_, i) => ({
      index: i,
      fileId: `${curatorId}-v${i}`,
      nudge: `motion ${i}`,
      generatedAt: "2026-07-21T00:00:00.000Z",
    }));
    store.save(asset);
    mkdirSync(store.paths.visualizers, { recursive: true });
    for (const c of asset.videoClips)
      writeFileSync(
        store.paths.visualizerFile(c.fileId),
        Buffer.from(c.fileId),
      );
    return { app, store, curatorId };
  }

  it("splices all clips into one loop and attaches it, advancing to preview", async () => {
    const { app, store, curatorId } = await serverWithClips(3);
    const res = await post(app, `/api/albums/${curatorId}/video/splice`);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("awaiting_preview");
    expect(res.json().visualizer.fileId).toBe(curatorId);
    expect(store.read(curatorId)!.visualizer?.originalFilename).toBe(
      "spliced-loop.mp4",
    );
  });

  it("accepts a reordered/deselected subset in the body", async () => {
    const { app, store, curatorId } = await serverWithClips(3);
    const res = await post(app, `/api/albums/${curatorId}/video/splice`, {
      order: [2, 0],
    });
    expect(res.statusCode).toBe(200);
    expect(store.read(curatorId)!.visualizer?.fileId).toBe(curatorId);
  });

  it("400s a splice with no generated clips", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum();
    const res = await post(app, `/api/albums/${curatorId}/video/splice`);
    expect(res.statusCode).toBe(400);
  });
});
