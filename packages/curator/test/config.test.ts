import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

const noFile = () => {
  process.env.CURATOR_CONFIG = join(
    mkdtempSync(join(tmpdir(), "cfg-")),
    "absent.toml",
  );
};
const withFile = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.toml");
  writeFileSync(file, contents);
  process.env.CURATOR_CONFIG = file;
};

describe("loadConfig", () => {
  it("uses defaults with no config file and no env", () => {
    noFile();
    delete process.env.CURATOR_PORT;
    delete process.env.MARQUEE_DATA_DIR;
    const c = loadConfig();
    expect(c.port).toBe(4739);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toMatch(/marquee$/);
  });

  it("falls back to env for port and data dir", () => {
    noFile();
    process.env.CURATOR_PORT = "5001";
    process.env.MARQUEE_DATA_DIR = join(tmpdir(), "md");
    const c = loadConfig();
    expect(c.port).toBe(5001);
    expect(c.dataDir).toBe(resolve(join(tmpdir(), "md")));
  });

  it("reads values from config.toml", () => {
    withFile(
      '[server]\nport = 4800\n[storage]\ndata_dir = "/tmp/marqueedata"\n',
    );
    const c = loadConfig();
    expect(c.port).toBe(4800);
    expect(c.dataDir).toBe(resolve("/tmp/marqueedata"));
  });

  it("prefers the file over env, and an explicit override over everything", () => {
    withFile("[server]\nport = 4800\n");
    process.env.CURATOR_PORT = "5001";
    expect(loadConfig().port).toBe(4800);
    expect(loadConfig({ port: 9999 }).port).toBe(9999);
  });

  // Upload ceiling (issue #12): a compiled-in 500 MB cap rejected real ~1 GB visualizer videos.
  it("defaults the upload ceiling high enough for a ~1 GB visualizer video", () => {
    noFile();
    delete process.env.CURATOR_MAX_UPLOAD_MB;
    const c = loadConfig();
    expect(c.maxUploadBytes).toBe(2048 * 1024 * 1024);
    expect(c.maxUploadBytes).toBeGreaterThanOrEqual(1024 ** 3);
  });

  it("takes the upload ceiling from env or config.toml, file winning", () => {
    noFile();
    process.env.CURATOR_MAX_UPLOAD_MB = "256";
    expect(loadConfig().maxUploadBytes).toBe(256 * 1024 * 1024);

    withFile("[storage]\nmax_upload_mb = 512\n");
    expect(loadConfig().maxUploadBytes).toBe(512 * 1024 * 1024);
  });

  // A nonsense ceiling would otherwise wedge every upload behind a NaN/zero limit.
  it.each(["not-a-number", "0", "-1", ""])(
    "falls back to the default ceiling for a malformed value (%j)",
    (value) => {
      noFile();
      process.env.CURATOR_MAX_UPLOAD_MB = value;
      expect(loadConfig().maxUploadBytes).toBe(2048 * 1024 * 1024);
    },
  );

  // The packaged desktop app has no repo .env — it reads Spotify creds from settings.json in the
  // data dir (written by the in-app Settings screen).
  it("reads Spotify creds from settings.json in the data dir", () => {
    noFile();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ spotify: { clientId: "cid", clientSecret: "csec" } }),
    );
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().spotify).toEqual({
      clientId: "cid",
      clientSecret: "csec",
    });
  });

  // The guard in readSettings: a corrupt settings.json must degrade to "no creds", not crash boot.
  it("ignores a malformed settings.json rather than crashing at boot", () => {
    noFile();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    writeFileSync(join(dir, "settings.json"), "{ not valid json");
    process.env.MARQUEE_DATA_DIR = dir;
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().spotify).toBeUndefined();
  });

  it("prefers env/config.toml Spotify creds over settings.json (dev unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ spotify: { clientId: "file", clientSecret: "file" } }),
    );
    process.env.MARQUEE_DATA_DIR = dir;
    process.env.SPOTIFY_CLIENT_ID = "env";
    process.env.SPOTIFY_CLIENT_SECRET = "env";
    noFile();
    expect(loadConfig().spotify).toEqual({
      clientId: "env",
      clientSecret: "env",
    });
  });
});
