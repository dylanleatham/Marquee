/**
 * Serving the built UI — the block that used to be unreachable under test.
 *
 * Two production outages came out of it, both invisible to the suite because a test run has no
 * `dist-ui` and the whole `if (existsSync(uiDir))` block was skipped:
 *
 * - [#183](https://github.com/dylanleatham/Marquee/issues/183): an asset miss answered with
 *   `index.html`, so the browser executed HTML as a module script — a solid black window, nothing in
 *   any log.
 * - [#241](https://github.com/dylanleatham/Marquee/issues/241): routes enumerated once at
 *   registration, so a Curator process that outlived a UI rebuild had no route for the new
 *   content-hashed bundle — a blank page and two 404s.
 *
 * `opts.uiDir` exists so these can be tested at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { AssetStore } from "../src/store/asset-store.js";
import { fakeRoadie } from "./helpers.js";

/** A `dist-ui` shaped like Vite's output: an index.html referencing one content-hashed bundle. */
function distUi(assetName = "index-AAA111.js") {
  const dir = mkdtempSync(join(tmpdir(), "curator-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><script type="module" src="/assets/${assetName}"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dir, "assets", assetName), "console.log('bundle')");
  return dir;
}

/**
 * Built **and awaited**. `app.ready()` is what runs the static plugin's registration glob, and
 * Fastify defers that to the first `inject()` — so a test that writes files before injecting has the
 * glob see them, and proves nothing about a process that outlived a rebuild. That mistake made the
 * #241 regression test green on the unfixed code.
 */
const serverFor = async (uiDir: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), "curator-uid-"));
  const store = new AssetStore(dataDir);
  const app = buildServer({ store, roadie: fakeRoadie(store), uiDir }).app;
  await app.ready();
  return app;
};

let uiDir: string;
beforeEach(() => {
  uiDir = distUi();
});

describe("serving the built UI", () => {
  it("serves index.html at the root, and the bundle it names", async () => {
    const app = await serverFor(uiDir);
    const page = await app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("index-AAA111.js");
    expect(
      (await app.inject({ url: "/assets/index-AAA111.js" })).statusCode,
    ).toBe(200);
  });

  it("serves a bundle written *after* boot — a rebuild must not need a restart", async () => {
    // #241. Vite content-hashes every build, so a rebuilt UI has filenames the running process has
    // never seen. Enumerating the directory once at registration meant the freshly-built index.html
    // was served while every asset it named 404'd: a blank window.
    const app = await serverFor(uiDir);
    // Faithfully: `vite build` empties the output dir and writes new content-hashed names, so the
    // old files are *gone*, not merely joined by new ones.
    rmSync(join(uiDir, "assets"), { recursive: true, force: true });
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(
      join(uiDir, "assets", "index-BBB222.js"),
      "console.log('new')",
    );
    const res = await app.inject({ url: "/assets/index-BBB222.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("new");
  });

  it("serves the rebuilt index.html, not the one read at boot", async () => {
    // The same staleness one level up: the SPA fallback held a buffer read at registration, so after
    // a rebuild a deep link served HTML naming the *old* bundle even once the assets were fixed.
    const app = await serverFor(uiDir);
    writeFileSync(
      join(uiDir, "index.html"),
      `<!doctype html><html><head><script type="module" src="/assets/index-BBB222.js"></script></head><body></body></html>`,
    );
    expect((await app.inject({ url: "/" })).body).toContain("index-BBB222.js");
    // …and on the deep-link path too, which is the one that was buffered.
    expect((await app.inject({ url: "/albums/abc12345" })).body).toContain(
      "index-BBB222.js",
    );
  });

  it("still answers a client route with index.html, so deep links reload", async () => {
    const app = await serverFor(uiDir);
    for (const url of ["/albums/abc12345", "/room/abc12345", "/settings"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toContain("text/html");
      expect(res.body, url).toContain('<div id="root">');
    }
  });

  it("still 404s a missing *file* rather than answering it with HTML", async () => {
    // #183, the reason the fallback is narrow. A miss answered with index.html makes the browser
    // execute HTML as a module script: React never mounts and nothing appears in any log.
    const app = await serverFor(uiDir);
    for (const url of [
      "/assets/gone-CCC333.js",
      "/assets/gone.css",
      "/x.png",
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<div id="root">');
    }
  });

  it("still 404s an unknown /api route as JSON, not as the app shell", async () => {
    const app = await serverFor(uiDir);
    const res = await app.inject({ url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("does not fall over when there is no built UI at all (dev/test)", async () => {
    const gone = mkdtempSync(join(tmpdir(), "curator-noui-"));
    rmSync(gone, { recursive: true, force: true });
    const app = await serverFor(gone);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });
});
