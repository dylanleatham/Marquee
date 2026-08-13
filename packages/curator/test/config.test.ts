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
    expect(loadConfig().spotify).toMatchObject({
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

  it("resolves the Gemini key from config.toml, env, then settings.json (file wins)", () => {
    // settings.json only
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ gemini: { apiKey: "from-settings" } }),
    );
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.GEMINI_API_KEY;
    noFile();
    expect(loadConfig().gemini?.apiKey).toBe("from-settings");

    // env beats settings.json
    process.env.GEMINI_API_KEY = "from-env";
    expect(loadConfig().gemini?.apiKey).toBe("from-env");

    // config.toml beats env
    withFile('[gemini]\napi_key = "from-file"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini?.apiKey).toBe("from-file");
  });

  it("defaults the opt-in generation flags to off, and reads them when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.GEMINI_GENERATE_CARD_ART;
    delete process.env.GEMINI_GENERATE_VIDEO;

    withFile('[gemini]\napi_key = "k"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini).toMatchObject({
      generateCardArt: false,
      generateVideo: false,
    });

    withFile('[gemini]\napi_key = "k"\ngenerate_card_art = true\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini).toMatchObject({
      generateCardArt: true,
      generateVideo: false,
    });

    // env string "1" counts as true
    noFile();
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_GENERATE_VIDEO = "1";
    expect(loadConfig().gemini?.generateVideo).toBe(true);
  });

  // Discogs auto-sync (issue #234 / ADR 0051). Same opt-in shape as the generation flags above: a
  // background job that reaches the network and writes to the library must not switch itself on.
  it("defaults Discogs auto-sync to off, and reads it when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.DISCOGS_AUTO_SYNC;
    delete process.env.DISCOGS_AUTO_SYNC_INTERVAL_MINUTES;

    withFile('[discogs]\ntoken = "t"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs?.autoSync).toBeUndefined();
    expect(loadConfig().discogs?.autoSyncIntervalMinutes).toBeUndefined();

    withFile('[discogs]\ntoken = "t"\nauto_sync = true\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs?.autoSync).toBe(true);
  });

  it("reads the auto-sync interval, and ignores a non-numeric one", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.DISCOGS_AUTO_SYNC;
    delete process.env.DISCOGS_AUTO_SYNC_INTERVAL_MINUTES;

    withFile('[discogs]\ntoken = "t"\nauto_sync_interval_minutes = 30\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs?.autoSyncIntervalMinutes).toBe(30);

    // Garbage is dropped rather than passed through as NaN — the poller would then clamp NaN and
    // every comparison against it would be false.
    withFile('[discogs]\ntoken = "t"\nauto_sync_interval_minutes = "soon"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs?.autoSyncIntervalMinutes).toBeUndefined();
  });

  it("takes auto-sync from env and settings.json, config.toml winning", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        discogs: { token: "t", autoSync: true, autoSyncIntervalMinutes: 45 },
      }),
    );
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.DISCOGS_AUTO_SYNC;
    delete process.env.DISCOGS_AUTO_SYNC_INTERVAL_MINUTES;
    noFile();
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs).toMatchObject({
      autoSync: true,
      autoSyncIntervalMinutes: 45,
    });

    // env beats settings.json — "1" counts as true, matching the generation flags.
    process.env.DISCOGS_AUTO_SYNC_INTERVAL_MINUTES = "15";
    expect(loadConfig().discogs?.autoSyncIntervalMinutes).toBe(15);

    // config.toml beats env
    withFile('[discogs]\ntoken = "t"\nauto_sync_interval_minutes = 90\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().discogs?.autoSyncIntervalMinutes).toBe(90);
  });

  it("reads model-slug overrides from config.toml/env (default: undefined → client picks)", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    delete process.env.GEMINI_TEXT_MODEL;
    delete process.env.GEMINI_IMAGE_MODEL;
    delete process.env.GEMINI_VIDEO_MODEL;

    // No override → the slug fields are absent (GeminiClient falls back to its own defaults).
    withFile('[gemini]\napi_key = "k"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini?.textModel).toBeUndefined();

    // config.toml override
    withFile('[gemini]\napi_key = "k"\ntext_model = "gemini-flash-latest"\n');
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini?.textModel).toBe("gemini-flash-latest");

    // env override
    noFile();
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_VIDEO_MODEL = "veo-3.1-fast";
    expect(loadConfig().gemini?.videoModel).toBe("veo-3.1-fast");
  });

  it("leaves gemini undefined when no key is configured anywhere", () => {
    noFile();
    delete process.env.GEMINI_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    expect(loadConfig().gemini).toBeUndefined();
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
    expect(loadConfig().spotify).toMatchObject({
      clientId: "env",
      clientSecret: "env",
    });
  });

  it("leaves backdrop sync undefined until a Backdrop URL is configured", () => {
    noFile();
    delete process.env.BACKDROP_URL;
    expect(loadConfig().backdrop).toBeUndefined();
  });

  it("configures backdrop sync from env, defaulting mediaDir under the data dir", () => {
    noFile();
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    process.env.MARQUEE_DATA_DIR = dir;
    process.env.BACKDROP_URL = "http://backdrop-pi:4740";
    process.env.TRIGGER_SHARED_SECRET = "shh";
    delete process.env.BACKDROP_MEDIA_DIR;
    delete process.env.BACKDROP_SYNC_MEDIA_LOCALLY;
    delete process.env.BACKDROP_MEDIA_TRANSFER;
    expect(loadConfig().backdrop).toEqual({
      url: "http://backdrop-pi:4740",
      sharedSecret: "shh",
      mediaDir: resolve(join(dir, "media", "visualizers")),
      mediaTransfer: "none",
      syncMediaLocally: false,
    });
  });

  it("reads the Backdrop media dir and local-sync flag from config.toml", () => {
    withFile(
      '[backdrop]\nurl = "http://pi:4740"\nmedia_dir = "/srv/vis"\nsync_media_locally = true\n',
    );
    expect(loadConfig().backdrop).toMatchObject({
      url: "http://pi:4740",
      // Local sync means the media dir really is on *this* filesystem, so resolving it is right.
      mediaDir: resolve("/srv/vis"),
      syncMediaLocally: true,
    });
  });

  /**
   * Issue #166. In the split deployment (runbook §Topology: Curator on the workstation, Backdrop on
   * the Pi) `media_dir` is a path on *another host*. Resolving it against Curator's own filesystem is
   * meaningless there, and on Windows it is destructive: `resolve("/home/pi/x")` returns
   * `C:\home\pi\x`, which the projection turns into a `C:/home/pi/x` filePath that fails Backdrop's
   * "must sit under media_dir" check — so no album can ever play.
   */
  it("keeps a remote POSIX media dir verbatim, drive letter and all platforms", () => {
    withFile(
      '[backdrop]\nurl = "http://pi:4740"\nmedia_dir = "/home/pi/marquee-data/media/visualizers"\n',
    );
    const { backdrop } = loadConfig();
    expect(backdrop?.syncMediaLocally).toBe(false);
    expect(backdrop?.mediaDir).toBe("/home/pi/marquee-data/media/visualizers");
    // The failure this guards is specifically a drive letter appearing on a POSIX path.
    expect(backdrop?.mediaDir).not.toMatch(/^[A-Za-z]:/);
    expect(backdrop?.mediaDir).not.toContain("\\");
  });

  /**
   * ADR 0038. There were two states (rsync / local copy) so a boolean sufficed; there are now three,
   * because Curator can push the file over HTTP. `sync_media_locally` stays honoured so an existing
   * config.toml keeps working — a silent change of transfer mode on upgrade would be the worst
   * possible failure here.
   */
  it("reads the media transfer mode from config.toml", () => {
    withFile('[backdrop]\nurl = "http://pi:4740"\nmedia_transfer = "push"\n');
    expect(loadConfig().backdrop).toMatchObject({
      mediaTransfer: "push",
      syncMediaLocally: false,
    });
  });

  it("defaults to no transfer, preserving the out-of-band rsync deployment", () => {
    withFile('[backdrop]\nurl = "http://pi:4740"\n');
    expect(loadConfig().backdrop).toMatchObject({
      mediaTransfer: "none",
      syncMediaLocally: false,
    });
  });

  it("still honours the legacy sync_media_locally boolean", () => {
    withFile('[backdrop]\nurl = "http://pi:4740"\nsync_media_locally = true\n');
    expect(loadConfig().backdrop).toMatchObject({
      mediaTransfer: "local",
      syncMediaLocally: true,
    });
  });

  it("lets an explicit media_transfer win over the legacy boolean", () => {
    withFile(
      '[backdrop]\nurl = "http://pi:4740"\nsync_media_locally = true\nmedia_transfer = "push"\n',
    );
    expect(loadConfig().backdrop).toMatchObject({
      mediaTransfer: "push",
      syncMediaLocally: false,
    });
  });

  it("falls back to none for an unrecognised mode rather than guessing", () => {
    withFile('[backdrop]\nurl = "http://pi:4740"\nmedia_transfer = "ftp"\n');
    expect(loadConfig().backdrop?.mediaTransfer).toBe("none");
  });

  it("reads the media transfer mode from the environment", () => {
    noFile();
    process.env.BACKDROP_URL = "http://backdrop-pi:4740";
    process.env.BACKDROP_MEDIA_TRANSFER = "push";
    delete process.env.BACKDROP_SYNC_MEDIA_LOCALLY;
    expect(loadConfig().backdrop?.mediaTransfer).toBe("push");
  });

  it("keeps a remote POSIX media dir verbatim when it comes from the environment", () => {
    noFile();
    process.env.BACKDROP_URL = "http://backdrop-pi:4740";
    process.env.BACKDROP_MEDIA_DIR = "/home/pi/marquee-data/media/visualizers";
    delete process.env.BACKDROP_SYNC_MEDIA_LOCALLY;
    expect(loadConfig().backdrop?.mediaDir).toBe(
      "/home/pi/marquee-data/media/visualizers",
    );
  });

  // ADR 0045. `conductor.url` always has a value (the Demo Room proxy needs somewhere to aim), so
  // presence cannot gate the asset push the way it does for Backdrop — an explicit URL does.
  describe("conductor.pushAssets", () => {
    const clearConductorEnv = () => {
      delete process.env.CONDUCTOR_URL;
      delete process.env.CURATOR_CONDUCTOR_PUSH_ASSETS;
    };

    it("is off when the URL is only the localhost default", () => {
      noFile();
      clearConductorEnv();
      const c = loadConfig();
      expect(c.conductor.url).toBe("http://localhost:4737");
      expect(c.conductor.pushAssets).toBe(false);
    });

    it("is on once a URL is configured explicitly", () => {
      noFile();
      clearConductorEnv();
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      expect(loadConfig().conductor.pushAssets).toBe(true);
    });

    it("can be forced off while keeping the URL for the demo proxy", () => {
      noFile();
      clearConductorEnv();
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      process.env.CURATOR_CONDUCTOR_PUSH_ASSETS = "false";
      expect(loadConfig().conductor.pushAssets).toBe(false);
    });

    it("can be forced on for a co-located Conductor (the desktop app)", () => {
      noFile();
      clearConductorEnv();
      process.env.CURATOR_CONDUCTOR_PUSH_ASSETS = "true";
      const c = loadConfig();
      expect(c.conductor.url).toBe("http://localhost:4737");
      expect(c.conductor.pushAssets).toBe(true);
    });

    it("reads the opt-in from config.toml", () => {
      clearConductorEnv();
      withFile(
        '[conductor]\nurl = "http://runtime-pi:4737"\npush_assets = false\n',
      );
      expect(loadConfig().conductor.pushAssets).toBe(false);
    });
  });

  /**
   * **Where the album-assets store has to land is a list, not a URL**
   * ([ADR 0079](../../../docs/adrs/0079-the-asset-push-has-more-than-one-target.md) / [#306](https://github.com/dylanleatham/Marquee/issues/306)).
   *
   * `conductor.url` answers "which Conductor do I talk to" — the Demo Room proxy, a simulated scan,
   * the settings. On the desktop app that is the **co-located** Conductor, and pinning it there was
   * right (issue #164). The bug was that pinning it there also silently re-pointed the *push*, whose
   * job is to reach every host that reads the store — including the Pi, where Amp lives. The two
   * questions had one answer, and the wrong one won.
   */
  describe("conductor.assetTargets", () => {
    const clearConductorEnv = () => {
      delete process.env.CONDUCTOR_URL;
      delete process.env.CURATOR_CONDUCTOR_PUSH_ASSETS;
      delete process.env.MARQUEE_COLOCATED_CONDUCTOR_URL;
      delete process.env.CONDUCTOR_ASSET_TARGETS;
    };

    it("is just the configured Conductor when nothing else is set", () => {
      noFile();
      clearConductorEnv();
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      expect(loadConfig().conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://runtime-pi:4737",
      ]);
    });

    /** The shape that was broken: a desktop shell *and* a real runtime. Both read the store. */
    it("carries the co-located Conductor and the configured one, in that order", () => {
      noFile();
      clearConductorEnv();
      process.env.MARQUEE_COLOCATED_CONDUCTOR_URL = "http://localhost:4737";
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      const c = loadConfig();

      // The co-located one is what Curator *talks to* — issue #164's fix, unchanged.
      expect(c.conductor.url).toBe("http://localhost:4737");
      // …and both get the store. Local first: it is instant, and it is what the Demo Room reads.
      expect(c.conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://localhost:4737",
        "http://runtime-pi:4737",
      ]);
      expect(c.conductor.pushAssets).toBe(true);
    });

    it("does not push the same store twice when both name one host", () => {
      noFile();
      clearConductorEnv();
      process.env.MARQUEE_COLOCATED_CONDUCTOR_URL = "http://localhost:4737";
      process.env.CONDUCTOR_URL = "http://localhost:4737/";
      expect(loadConfig().conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://localhost:4737",
      ]);
    });

    it("takes an explicit list, which wins over both", () => {
      noFile();
      clearConductorEnv();
      process.env.MARQUEE_COLOCATED_CONDUCTOR_URL = "http://localhost:4737";
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      process.env.CONDUCTOR_ASSET_TARGETS = "http://a:4737, http://b:4737";
      expect(loadConfig().conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://a:4737",
        "http://b:4737",
      ]);
    });

    it("reads the list from config.toml", () => {
      clearConductorEnv();
      withFile(
        '[conductor]\nurl = "http://runtime-pi:4737"\nasset_targets = ["http://a:4737", "http://b:4737"]\n',
      );
      expect(loadConfig().conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://a:4737",
        "http://b:4737",
      ]);
    });

    it("hands every target the shared secret, since one LAN secret covers the runtime", () => {
      noFile();
      clearConductorEnv();
      process.env.TRIGGER_SHARED_SECRET = "s3cr3t";
      process.env.MARQUEE_COLOCATED_CONDUCTOR_URL = "http://localhost:4737";
      process.env.CONDUCTOR_URL = "http://runtime-pi:4737";
      const targets = loadConfig().conductor.assetTargets;
      expect(targets.map((t) => t.sharedSecret)).toEqual(["s3cr3t", "s3cr3t"]);
    });

    /**
     * The desktop app with no runtime configured at all: one target, the bundled Conductor, and the
     * push is on — otherwise the shell's own Conductor would go unfed the moment it stopped
     * masquerading as `CONDUCTOR_URL`.
     */
    it("pushes to the co-located Conductor even when nothing else is configured", () => {
      noFile();
      clearConductorEnv();
      process.env.MARQUEE_COLOCATED_CONDUCTOR_URL = "http://localhost:4737";
      const c = loadConfig();
      expect(c.conductor.pushAssets).toBe(true);
      expect(c.conductor.assetTargets.map((t) => t.url)).toEqual([
        "http://localhost:4737",
      ]);
    });
  });

  it("derives the Spotify OAuth redirect URI from host + port by default", () => {
    noFile();
    process.env.SPOTIFY_CLIENT_ID = "id";
    process.env.SPOTIFY_CLIENT_SECRET = "secret";
    delete process.env.SPOTIFY_REDIRECT_URI;
    expect(loadConfig().spotify?.redirectUri).toBe(
      "http://127.0.0.1:4739/api/spotify/auth/callback",
    );
    // Overridable for a non-default host/port or a specific registered URI.
    process.env.SPOTIFY_REDIRECT_URI = "http://127.0.0.1:9999/cb";
    expect(loadConfig().spotify?.redirectUri).toBe("http://127.0.0.1:9999/cb");
  });
});
