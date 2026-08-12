import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { Library } from "../src/library.js";
import { FakeTimers, tempMedia, tempDataDir } from "./fakes.js";

const SECRET = "test-secret";
const AUTH = { "x-trigger-secret": SECRET };
const URI = "curator:album:x";

/** A server whose library has one album whose video exists on disk under mediaDir. */
function build() {
  const { dir, paths } = tempMedia(["x.mp4"]);
  const library = new Library(tempDataDir());
  library.upsert(URI, { filePath: paths["x.mp4"]!, durationSec: 187 });
  const built = buildServer({
    config: { sharedSecret: SECRET, mediaDir: dir },
    library,
    timers: new FakeTimers(), // no real 90-min idle timer leaks out of the test
  });
  return { ...built, mediaDir: dir, videoPath: paths["x.mp4"]! };
}

describe("backdrop HTTP API", () => {
  it("/healthz is open and 503s until a browser is attached", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, browserConnected: false });
  });

  it("rejects /api/scan without the shared secret", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: { event: "stop", at: "t" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/scan start plays the album and returns 202", async () => {
    const { app, controller } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "start", uri: URI, tagUid: "04:A1", at: "t" },
    });
    expect(res.statusCode).toBe(202);
    expect(controller.status().state).toBe("playing");
    expect(controller.status().uri).toBe(URI);
  });

  it("POST /api/scan stop returns to idle", async () => {
    const { app, controller } = build();
    await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "start", uri: URI, tagUid: "04:A1", at: "t" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "stop", at: "t" },
    });
    expect(res.statusCode).toBe(202);
    expect(controller.status().state).toBe("idle");
  });

  it("POST /api/scan 400s on a malformed body", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "start" }, // no uri
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/scan 400s on a start missing tagUid (contract requires it)", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "start", uri: URI, at: "t" }, // no tagUid
    });
    expect(res.statusCode).toBe(400);
  });

  it("a scan for an unknown album is accepted but stays idle (no blackscreen)", async () => {
    const { app, controller } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: {
        event: "start",
        uri: "curator:album:unknown",
        tagUid: "04:A1",
        at: "t",
      },
    });
    expect(res.statusCode).toBe(202); // accepted…
    expect(controller.status().state).toBe("idle"); // …but nothing played
  });

  it("POST /api/library/sync replaces the map; GET /api/library reads it back", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/library/sync",
      headers: AUTH,
      payload: {
        entries: [
          {
            uri: "curator:album:a",
            filePath: "/media/a.mp4",
            durationSec: 100,
          },
          { uri: "curator:album:b", filePath: "/media/b.mp4" },
        ],
      },
    });
    expect(res.json()).toEqual({ synced: 2 });

    const get = await app.inject({
      method: "GET",
      url: "/api/library",
      headers: AUTH,
    });
    const lib = get.json();
    expect(Object.keys(lib.entries).sort()).toEqual([
      "curator:album:a",
      "curator:album:b",
    ]);
    expect(lib.entries["curator:album:x"]).toBeUndefined(); // full replace dropped the seed
  });

  it("POST /api/library/sync 400s when an entry lacks uri/filePath", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/library/sync",
      headers: AUTH,
      payload: { entries: [{ uri: "curator:album:a" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/library/update upserts a single entry", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/library/update",
      headers: AUTH,
      payload: { uri: "curator:album:new", filePath: "/media/new.mp4" },
    });
    expect(res.json()).toEqual({ updated: "curator:album:new" });
  });

  it("POST /api/library/update merges into an existing entry, preserving omitted fields", async () => {
    const { app } = build(); // seed: URI → { filePath, durationSec: 187 }
    const res = await app.inject({
      method: "POST",
      url: "/api/library/update",
      headers: AUTH,
      payload: { uri: URI, contentHash: "sha256:new" }, // no filePath/durationSec
    });
    expect(res.json()).toEqual({ updated: URI });
    const get = await app.inject({
      method: "GET",
      url: "/api/library",
      headers: AUTH,
    });
    const entry = get.json().entries[URI];
    expect(entry.durationSec).toBe(187); // preserved from the seed
    expect(entry.contentHash).toBe("sha256:new"); // applied
    expect(typeof entry.filePath).toBe("string"); // preserved
  });

  it("DELETE /api/library/:uri removes an entry", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/${encodeURIComponent(URI)}`,
      headers: AUTH,
    });
    expect(res.json()).toEqual({ removed: true });
    const get = await app.inject({
      method: "GET",
      url: "/api/library",
      headers: AUTH,
    });
    expect(get.json().entries[URI]).toBeUndefined();
  });

  it("DELETE /api/library/:uri reports removed:false for an unknown entry", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/library/${encodeURIComponent("curator:album:nope")}`,
      headers: AUTH,
    });
    expect(res.json()).toEqual({ removed: false });
  });

  // Listed-but-unplayable is the failure Curator cannot otherwise see: the entry and the bytes move
  // on separate legs (ADR 0038), so an entry can be present while the mp4 never arrived.
  describe("GET /api/library reports playability", () => {
    const getLibrary = (app: ReturnType<typeof build>["app"]) =>
      app.inject({ method: "GET", url: "/api/library", headers: AUTH });

    it("marks an entry whose file is on disk as present", async () => {
      const { app } = build();
      const entry = (await getLibrary(app)).json().entries[URI];
      expect(entry.fileMissing).toBe(false);
      expect(entry.durationSec).toBe(187); // the stored fields still come through
    });

    it("marks an entry whose file was never transferred as missing", async () => {
      const { app, mediaDir } = build();
      await app.inject({
        method: "POST",
        url: "/api/library/update",
        headers: AUTH,
        payload: {
          uri: "curator:album:ghost123",
          filePath: `${mediaDir}/ghost123.mp4`,
        },
      });
      const entries = (await getLibrary(app)).json().entries;
      expect(entries["curator:album:ghost123"].fileMissing).toBe(true);
      expect(entries[URI].fileMissing).toBe(false);
    });

    it("marks an entry pointing outside mediaDir as missing, matching what play() would refuse", async () => {
      const { app, controller } = build();
      const outside = "curator:album:outside1";
      await app.inject({
        method: "POST",
        url: "/api/library/update",
        headers: AUTH,
        payload: { uri: outside, filePath: "/etc/passwd" },
      });
      expect((await getLibrary(app)).json().entries[outside].fileMissing).toBe(
        true,
      );
      // The report and the enforcement agree — that's the point of sharing fileIsPlayable.
      controller.play(outside);
      expect(controller.status().state).toBe("idle");
    });
  });

  // The default visualizer (ADR 0073) — an unfinished record is a first-class library entry that
  // names no file of its own, so the sync API has to carry that shape and `GET /api/library` has to
  // judge it against the clip it will actually play.
  describe("usesDefault entries", () => {
    /** A server with a default clip on disk and one unfinished record in the library. */
    function buildWithDefault() {
      const { dir, paths } = tempMedia(["x.mp4", "default.mp4"]);
      const library = new Library(tempDataDir());
      library.upsert(URI, { filePath: paths["x.mp4"]!, durationSec: 187 });
      library.upsert("curator:album:unfinishd", { usesDefault: true });
      const built = buildServer({
        config: {
          sharedSecret: SECRET,
          mediaDir: dir,
          defaultVisualizerPath: paths["default.mp4"]!,
        },
        library,
        timers: new FakeTimers(),
      });
      return { ...built, mediaDir: dir, defaultPath: paths["default.mp4"]! };
    }

    it("POST /api/library/sync accepts an entry with usesDefault and no filePath", async () => {
      const { app } = build();
      const res = await app.inject({
        method: "POST",
        url: "/api/library/sync",
        headers: AUTH,
        payload: {
          entries: [
            { uri: "curator:album:a", filePath: "/media/a.mp4" },
            { uri: "curator:album:b", usesDefault: true },
          ],
        },
      });
      expect(res.json()).toEqual({ synced: 2 });
      const entries = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries;
      expect(entries["curator:album:b"].usesDefault).toBe(true);
      expect(entries["curator:album:b"].filePath).toBeUndefined();
    });

    // "No filePath" has to be something Curator said on purpose. A malformed push that fell into
    // the fallback would park records on the default clip and look like it worked. The empty string
    // is the sharp edge: it passes a `typeof === "string"` check and then reads as *no* video
    // downstream, which is the malformed push becoming a fallback by the back door.
    it.each([
      ["neither field", { uri: "curator:album:a" }],
      ["an empty filePath", { uri: "curator:album:a", filePath: "" }],
      // Contradictory: two readers already resolve it differently, so neither answer is the entry's.
      [
        "both fields",
        { uri: "curator:album:a", filePath: "/m/a.mp4", usesDefault: true },
      ],
    ])("POST /api/library/sync 400s on an entry with %s", async (_, entry) => {
      const { app } = build();
      const res = await app.inject({
        method: "POST",
        url: "/api/library/sync",
        headers: AUTH,
        payload: { entries: [entry] },
      });
      expect(res.statusCode).toBe(400);
      // Nothing landed — a rejected sync must not half-replace the map.
      const entries = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries;
      expect(entries["curator:album:a"]).toBeUndefined();
    });

    it("POST /api/library/update 400s on an empty filePath for a new entry", async () => {
      const { app } = build();
      const res = await app.inject({
        method: "POST",
        url: "/api/library/update",
        headers: AUTH,
        payload: { uri: "curator:album:empty123", filePath: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/library/update 400s when a body sets both, and changes nothing", async () => {
      const { app } = build(); // seed: URI → { filePath, durationSec: 187 }
      const res = await app.inject({
        method: "POST",
        url: "/api/library/update",
        headers: AUTH,
        payload: { uri: URI, filePath: "/m/x.mp4", usesDefault: true },
      });
      expect(res.statusCode).toBe(400);
      const entry = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries[URI];
      expect(entry.durationSec).toBe(187); // the seed is untouched
      expect(entry.usesDefault).toBeUndefined();
    });

    // The detach path. Merging would leave Backdrop pointing at the video that was just removed —
    // and its contentHash would make the next sync skip re-uploading the replacement.
    it("POST /api/library/update with usesDefault replaces the entry, dropping the old file", async () => {
      const { app } = build(); // seed: URI → { filePath, durationSec: 187 }
      const res = await app.inject({
        method: "POST",
        url: "/api/library/update",
        headers: AUTH,
        payload: { uri: URI, usesDefault: true },
      });
      expect(res.json()).toEqual({ updated: URI });

      const entry = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries[URI];
      expect(entry.usesDefault).toBe(true);
      expect(entry.filePath).toBeUndefined();
      expect(entry.durationSec).toBeUndefined();
      expect(entry.contentHash).toBeUndefined();
    });

    it("a scan of an unfinished record plays the default and says so on /api/status", async () => {
      const { app, defaultPath } = buildWithDefault();
      const res = await app.inject({
        method: "POST",
        url: "/api/scan",
        headers: AUTH,
        payload: {
          event: "start",
          uri: "curator:album:unfinishd",
          tagUid: "04:A1",
          at: "t",
        },
      });
      expect(res.statusCode).toBe(202);

      const body = (
        await app.inject({ method: "GET", url: "/api/status", headers: AUTH })
      ).json();
      expect(body.state).toBe("playing");
      expect(body.uri).toBe("curator:album:unfinishd");
      expect(body.filePath).toBe(defaultPath);
      expect(body.usingDefault).toBe(true);
    });

    it("/api/status reports usingDefault:false for a record playing its own visualizer", async () => {
      const { app } = buildWithDefault();
      await app.inject({
        method: "POST",
        url: "/api/admin/play",
        headers: AUTH,
        payload: { uri: URI },
      });
      const body = (
        await app.inject({ method: "GET", url: "/api/status", headers: AUTH })
      ).json();
      expect(body.usingDefault).toBe(false);
    });

    // `fileMissing` answers "would a scan of this play anything". For these records that turns on
    // the default clip, not on a filePath they don't have.
    it("GET /api/library judges a usesDefault entry against the default clip", async () => {
      const { app } = buildWithDefault();
      const entries = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries;
      expect(entries["curator:album:unfinishd"].fileMissing).toBe(false);
    });

    it("GET /api/library marks every usesDefault entry missing when the default clip isn't there", async () => {
      const { dir } = tempMedia([]); // no default.mp4 ever synced
      const library = new Library(tempDataDir());
      library.upsert("curator:album:unfinishd", { usesDefault: true });
      const { app } = buildServer({
        config: {
          sharedSecret: SECRET,
          mediaDir: dir,
          defaultVisualizerPath: `${dir}/default.mp4`,
        },
        library,
        timers: new FakeTimers(),
      });
      const entries = (
        await app.inject({ method: "GET", url: "/api/library", headers: AUTH })
      ).json().entries;
      expect(entries["curator:album:unfinishd"].fileMissing).toBe(true);
    });
  });

  it("admin play / stop / simulate-scan drive the controller", async () => {
    const { app, controller } = build();

    let res = await app.inject({
      method: "POST",
      url: "/api/admin/play",
      headers: AUTH,
      payload: { uri: URI },
    });
    expect(res.statusCode).toBe(202);
    expect(controller.status().state).toBe("playing");

    res = await app.inject({
      method: "POST",
      url: "/api/admin/stop",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(202);
    expect(controller.status().state).toBe("idle");

    res = await app.inject({
      method: "POST",
      url: "/api/admin/simulate-scan",
      headers: AUTH,
      payload: { event: "start", uri: URI, tagUid: "04:A1", at: "t" },
    });
    expect(res.statusCode).toBe(202);
    expect(controller.status().state).toBe("playing");
  });

  it("GET /api/status reports state, uptime, and browser connection", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("idle");
    expect(body.browserConnected).toBe(false);
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.playbackQuality).toBeNull();
  });
});

// The kiosk's decoder counters are the only measurement of whether this board keeps up with a clip
// (issue #211); ADR 0040 set a decode budget with nothing watching the result. These pin the path
// from a browser frame to /api/status.
describe("playback quality reaches /api/status (issue #211)", () => {
  const status = async (app: ReturnType<typeof build>["app"]) =>
    (
      await app.inject({ method: "GET", url: "/api/status", headers: AUTH })
    ).json();

  /** Deliver a browser→backend frame the way a connected kiosk would. */
  const report = (
    hub: ReturnType<typeof build>["hub"],
    filePath: string,
    totalFrames: number,
    droppedFrames: number,
  ) =>
    hub.receive(
      JSON.stringify({
        type: "playback-quality",
        filePath,
        totalFrames,
        droppedFrames,
      }),
    );

  it("serves the drop rate for the clip that is on screen", async () => {
    const { app, hub, controller, videoPath } = build();
    controller.play(URI);

    report(hub, videoPath, 1800, 90);

    const body = await status(app);
    expect(body.state).toBe("playing");
    expect(body.playbackQuality).toMatchObject({
      filePath: videoPath,
      totalFrames: 1800,
      droppedFrames: 90,
      droppedPct: 5,
      degraded: true,
    });
  });

  it("serves a verdict about the last sample, not the whole clip (regression: #216)", async () => {
    // The monitor is stateful across WebSocket frames, and /api/status is where an operator reads
    // the result — so the delta has to survive the trip, not just hold inside QualityMonitor. On the
    // #211 deploy this endpoint kept saying `degraded` for minutes after a panel change had stopped
    // the drops, because it was serving a lifetime average.
    const { app, hub, controller, videoPath } = build();
    controller.play(URI);

    report(hub, videoPath, 5182, 285); // 5.5% at 4K — the board really is behind
    expect((await status(app)).playbackQuality.degraded).toBe(true);

    report(hub, videoPath, 5782, 285); // panel forced to 1080p: nothing dropped since
    expect((await status(app)).playbackQuality).toMatchObject({
      totalFrames: 5782,
      droppedFrames: 285,
      intervalFrames: 600,
      intervalDroppedFrames: 0,
      droppedPct: 0,
      degraded: false,
    });
  });

  it("drops the verdict once playback stops", async () => {
    // A "degraded" left over from the last album, served against an idle display, would send an
    // operator hunting a problem that isn't on screen.
    const { app, hub, controller, videoPath } = build();
    controller.play(URI);
    report(hub, videoPath, 1800, 90);
    controller.stop();

    expect((await status(app)).playbackQuality).toBeNull();
  });

  it("ignores a malformed frame rather than taking the backend down", async () => {
    const { app, hub, controller } = build();
    controller.play(URI);
    hub.receive("{not json");
    hub.receive(JSON.stringify({ type: "playback-quality" }));

    expect((await status(app)).state).toBe("playing");
  });
});
