import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

// Point CONDUCTOR_CONFIG at a path so loadConfig never picks up a real config.toml.
const noFile = () => {
  process.env.CONDUCTOR_CONFIG = join(
    mkdtempSync(join(tmpdir(), "cfg-")),
    "absent.toml",
  );
};
const withFile = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.toml");
  writeFileSync(file, contents);
  process.env.CONDUCTOR_CONFIG = file;
  return file;
};

describe("loadConfig", () => {
  it("uses defaults when there's no config file and no env", () => {
    noFile();
    delete process.env.TRIGGER_SHARED_SECRET;
    delete process.env.CONDUCTOR_PORT;
    const c = loadConfig();
    expect(c.port).toBe(4737);
    expect(c.sharedSecret).toBeNull();
    expect(c.idleTimeoutMinutes).toBe(90);
  });

  it("falls back to env for the shared secret and port", () => {
    noFile();
    process.env.TRIGGER_SHARED_SECRET = "envsecret";
    process.env.CONDUCTOR_PORT = "5000";
    const c = loadConfig();
    expect(c.sharedSecret).toBe("envsecret");
    expect(c.port).toBe(5000);
  });

  it("reads values from a config.toml", () => {
    withFile(
      '[server]\nport = 4800\n[auth]\nshared_secret = "filesecret"\n[runtime]\nidle_timeout_minutes = 30\n',
    );
    const c = loadConfig();
    expect(c.port).toBe(4800);
    expect(c.sharedSecret).toBe("filesecret");
    expect(c.idleTimeoutMinutes).toBe(30);
  });

  it("prefers the file over env, and an explicit override over everything", () => {
    withFile('[auth]\nshared_secret = "filesecret"\n');
    process.env.TRIGGER_SHARED_SECRET = "envsecret";
    expect(loadConfig().sharedSecret).toBe("filesecret");
    expect(loadConfig({ sharedSecret: "override" }).sharedSecret).toBe(
      "override",
    );
  });

  it("defaults albumAssetsDir under the data dir, and honors env / file overrides (issue #45)", () => {
    noFile();
    delete process.env.ALBUM_ASSETS_DIR;
    // Default: sits beside the (default) data dir.
    expect(loadConfig().albumAssetsDir).toMatch(/[\\/]data[\\/]album-assets$/);
    // Env override (absolute path wins). loadConfig resolves the configured value against the
    // package dir so a *relative* setting (the default, and the runbook's `data_dir = "data"`)
    // anchors somewhere sensible; an absolute one passes through untouched. Build the inputs with
    // resolve() so they're absolute on this platform too — a bare "/srv/..." literal is absolute on
    // the Pi but merely drive-relative on Windows, where resolve() correctly yields "C:\srv\...".
    const fromEnv = resolve("/srv/marquee/album-assets");
    process.env.ALBUM_ASSETS_DIR = fromEnv;
    expect(loadConfig().albumAssetsDir).toBe(fromEnv);
    // File override beats env. JSON.stringify escapes the backslashes a Windows path carries into
    // the TOML basic string; on POSIX it's just the quoted path.
    const fromToml = resolve("/from/toml/album-assets");
    withFile(`[storage]\nalbum_assets_dir = ${JSON.stringify(fromToml)}\n`);
    expect(loadConfig().albumAssetsDir).toBe(fromToml);
  });
});
