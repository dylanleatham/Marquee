// The dependencies **production** gets, as opposed to the ones tests hand it.
//
// regression: [#319](https://github.com/dylanleatham/Marquee/issues/319). `buildServer()` built
// `actionDeps` with `generate: opts.generate` and no fallback, while `Roadie` next to it read
// `opts.generate ?? defaultGenerate`. The shipped entry point calls `buildServer()` with no options,
// so Roadie extracted palettes on ingest and every human-triggered re-extract answered
// `400 palette generator isn't available` — BACK TO ROADIE'S ORIGINAL, the sleeve card's USE THIS
// INSTEAD, both artwork-override routes, and the library sweep.
//
// **Why nothing caught it.** Every other suite in this package injects `generate`, because a fake
// keeps node-vibrant out of the run. That is the right default for a test and it is exactly what
// made the hole invisible: the one construction nobody performed was production's. So this file's
// rule is the opposite of every other one — **inject only what production injects**, which is
// nothing but the store, and let the real dependency resolve. A suite that mocked its way to green
// here would be re-creating the blind spot it exists to close.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { makeAsset, pngBands } from "./helpers.js";

let store: AssetStore;

/** An album with a real, decodable, multi-coloured cover — something to actually extract from. */
const seed = (id = "wire0001") => {
  store.save(makeAsset(id, "Kind of Blue", "Miles Davis"));
  mkdirSync(store.paths.artwork, { recursive: true });
  writeFileSync(store.paths.artworkFile(id), pngBands());
  return id;
};

/**
 * Built the way `start()` builds it: **only** the store, which production resolves from config
 * rather than being handed. Passing anything else here would defeat the file's purpose.
 */
const production = () => buildServer({ store }).app;

beforeEach(() => {
  store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-wiring-")));
});

describe("buildServer — the wiring production actually gets", () => {
  it("re-extracts a palette with no generator injected", async () => {
    const id = seed();
    const res = await production().inject({
      method: "POST",
      url: `/api/albums/${id}/palette/generate`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().palette.colors.length).toBeGreaterThan(0);
  });

  // The same missing dependency, reached through the four other doors — this is the bug's family,
  // and each one is a control a human presses rather than an endpoint.
  it("puts the sleeve's palette back — BACK TO ROADIE'S ORIGINAL", async () => {
    const id = seed();
    const res = await production().inject({
      method: "POST",
      url: `/api/albums/${id}/palette/choose`,
      payload: { source: "cover" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the library sweep rather than answering 503", async () => {
    const res = await production().inject({
      method: "POST",
      url: "/api/batch/regenerate-palettes",
    });
    // 202 is "here is your job" — the sweep's own progress is batch.test.ts's business, not this
    // file's. All that is asserted here is that it was not turned away at the door.
    expect(res.statusCode).toBe(202);
  });

  it("re-derives from an uploaded cover, and from the fetched one when it is dropped", async () => {
    const id = seed();
    const app = production();
    const { buildMultipart } = await import("./helpers.js");
    const mp = buildMultipart(
      { regeneratePalette: "true" },
      {
        field: "file",
        filename: "better-scan.png",
        contentType: "image/png",
        data: pngBands(["#0B6E4F", "#E8871E", "#124E78"]),
      },
    );

    const up = await app.inject({
      method: "POST",
      url: `/api/albums/${id}/artwork/override`,
      headers: { "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().paletteRegenerated).toBe(true);

    const down = await app.inject({
      method: "DELETE",
      url: `/api/albums/${id}/artwork/override`,
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().paletteRegenerated).toBe(true);
  });
});
