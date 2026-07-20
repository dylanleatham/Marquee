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
      payload: { event: "start", uri: URI, at: "t" },
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

  it("a scan for an unknown album is accepted but stays idle (no blackscreen)", async () => {
    const { app, controller } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: AUTH,
      payload: { event: "start", uri: "curator:album:unknown", at: "t" },
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
      payload: { event: "start", uri: URI, at: "t" },
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
  });
});
