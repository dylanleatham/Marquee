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
});
