import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
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
    expect(store.read(curatorId)!.promptDrafts!.video!.text).toContain(
      "Kaleidoscopic",
    );
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
  it("409s attaching a video from the wrong state", async () => {
    const { app, curatorId } = await serverWithReviewedAlbum(); // awaiting_review, not awaiting_video
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
