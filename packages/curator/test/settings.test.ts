import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie } from "./helpers.js";

// The Spotify Settings screen (packaged app has no repo .env): PUT persists creds to the data dir,
// and the next boot reads them back. clientId comes from MARQUEE_DATA_DIR so config + the PUT target
// agree on where settings.json lives.

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

function serverAt(dataDir: string) {
  process.env.MARQUEE_DATA_DIR = dataDir;
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.GEMINI_API_KEY;
  const store = new AssetStore(dataDir);
  const { app } = buildServer({ store, roadie: fakeRoadie(store) });
  return app;
}

describe("Spotify settings", () => {
  it("400s when a field is missing", async () => {
    const app = serverAt(mkdtempSync(join(tmpdir(), "curator-set-")));
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/spotify",
      payload: { clientId: "only-id" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists creds to settings.json and a fresh boot reads them back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-set-"));

    // Fresh install: not configured.
    const app1 = serverAt(dir);
    expect(
      (await app1.inject({ url: "/api/settings/spotify" })).json(),
    ).toEqual({ configured: false, clientId: null });

    const put = await app1.inject({
      method: "PUT",
      url: "/api/settings/spotify",
      payload: { clientId: "  cid  ", clientSecret: "  csec  " }, // trims
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true, restartRequired: true });

    // Written to the data dir, trimmed, and never returned to the client in the GET.
    const written = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    );
    expect(written.spotify).toEqual({ clientId: "cid", clientSecret: "csec" });

    // The Spotify client is built at boot, so a new server (same data dir) is the "restart".
    const app2 = serverAt(dir);
    const status = (await app2.inject({ url: "/api/settings/spotify" })).json();
    expect(status).toEqual({ configured: true, clientId: "cid" });
    // The secret is write-only — the GET must not leak it.
    expect(JSON.stringify(status)).not.toContain("csec");
  });

  it("does not leave a settings.json when nothing was ever saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-set-"));
    serverAt(dir);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });
});

describe("Gemini settings", () => {
  it("400s when the apiKey is missing", async () => {
    const app = serverAt(mkdtempSync(join(tmpdir(), "curator-gem-")));
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists the key to settings.json and a fresh boot reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-gem-"));

    const app1 = serverAt(dir);
    expect((await app1.inject({ url: "/api/settings/gemini" })).json()).toEqual(
      {
        configured: false,
        generateCardArt: false,
        generateVideo: false,
        generateCardArtPinned: false,
        generateVideoPinned: false,
      },
    );

    const put = await app1.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { apiKey: "  key-123  " }, // trims
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true, restartRequired: true });

    const written = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    );
    expect(written.gemini).toEqual({ apiKey: "key-123" });

    // The Gemini client is built at boot, so a new server (same data dir) is the "restart".
    const app2 = serverAt(dir);
    const status = (await app2.inject({ url: "/api/settings/gemini" })).json();
    expect(status).toEqual({
      configured: true,
      generateCardArt: false,
      generateVideo: false,
      generateCardArtPinned: false,
      generateVideoPinned: false,
    });
    // The key is write-only — the GET must not leak it.
    expect(JSON.stringify(status)).not.toContain("key-123");
  });

  it("toggles a generation flag without wiping the key (opt-in, merge)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-gem-"));
    const app = serverAt(dir);
    await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { apiKey: "key-123" },
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { generateCardArt: true },
    });
    expect(put.statusCode).toBe(200);
    const written = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    );
    // Key preserved, flag set.
    expect(written.gemini).toEqual({
      apiKey: "key-123",
      generateCardArt: true,
    });
  });

  it("reports a toggled flag back, so the checkbox bound to it stays where you put it", async () => {
    // The GET used to answer from consts captured at boot, so it never reflected a PUT until the
    // next restart — a checkbox bound to it snapped straight back and the setting looked broken
    // ([#240](https://github.com/dylanleatham/Marquee/issues/240)). The test above only ever
    // asserted on the *file*, which is why this survived.
    const dir = mkdtempSync(join(tmpdir(), "curator-gem-"));
    const app = serverAt(dir);
    await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { generateCardArt: true, generateVideo: true },
    });

    const after = (await app.inject({ url: "/api/settings/gemini" })).json();
    expect(after.generateCardArt).toBe(true);
    expect(after.generateVideo).toBe(true);

    // And back off again — the direction that actually bit.
    await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { generateVideo: false },
    });
    const off = (await app.inject({ url: "/api/settings/gemini" })).json();
    expect(off.generateVideo).toBe(false);
    expect(off.generateCardArt).toBe(true);
  });

  it("says a flag pinned above settings.json cannot be changed from the UI", async () => {
    // config.toml and the environment both sit *above* settings.json in the boot chain, so a click
    // there genuinely cannot take effect. The screen has to say so rather than offer a control that
    // silently loses — the same call as the read-only service URLs (curator-ui-ux §8.9).
    const dir = mkdtempSync(join(tmpdir(), "curator-gem-"));
    // The flags hang off `config.gemini`, which only exists once a key is set — pinning generation
    // with no key to generate with isn't a state worth modelling. The key goes through the API
    // rather than the environment because `serverAt` clears `GEMINI_API_KEY` for isolation (#32).
    await serverAt(dir).inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { apiKey: "key-123", generateVideo: false },
    });

    process.env.GEMINI_GENERATE_VIDEO = "true";
    try {
      const app = serverAt(dir);
      const status = (await app.inject({ url: "/api/settings/gemini" })).json();
      // The pin wins over the stored `false`, and says why it won.
      expect(status.generateVideo).toBe(true);
      expect(status.generateVideoPinned).toBe(true);
      expect(status.generateCardArtPinned).toBe(false);
    } finally {
      delete process.env.GEMINI_GENERATE_VIDEO;
    }
  });

  it("keeps Spotify creds intact when saving a Gemini key (merge, not overwrite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "curator-gem-"));
    const app = serverAt(dir);
    await app.inject({
      method: "PUT",
      url: "/api/settings/spotify",
      payload: { clientId: "cid", clientSecret: "csec" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/settings/gemini",
      payload: { apiKey: "gkey" },
    });
    const written = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    );
    expect(written.spotify).toEqual({ clientId: "cid", clientSecret: "csec" });
    expect(written.gemini).toEqual({ apiKey: "gkey" });
  });
});
