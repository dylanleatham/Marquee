// The test suite's own isolation from the developer's machine (issue #247).
//
// `setup-env.ts` exists so a configured workstation tests like a clean CI box. It was added in #32
// with a hand-written list of three variables, while `loadConfig` reads twenty-nine — so everything
// else leaked, from the repo `.env` and from the ambient user environment. The result was 49 red
// tests on `main` that CI was green on: mostly 5s timeouts, because `loadConfig` handed the tests
// the real Pi and they tried to dial it.
//
// These two tests are the gate. The first proves the isolation works; the second proves the list
// stays complete, which is the part a human would otherwise have to remember.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, CONFIG_ENV_VARS } from "../src/config.js";

/** A configured workstation, as it actually looks — these are real values from the one this failed on. */
const AMBIENT = {
  CONDUCTOR_URL: "http://pi:4738",
  BACKDROP_URL: "http://pi:4740",
  BACKDROP_MEDIA_TRANSFER: "push",
  BACKDROP_MEDIA_DIR: "/home/pi/marquee-data/media/visualizers",
  AMP_URL: "http://pi:4741",
  STYLUS_URL: "http://pi:4742",
  TRIGGER_SHARED_SECRET: "ambient-secret",
  DISCOGS_TOKEN: "ambient-token",
  DISCOGS_USERNAME: "ambient-user",
  GEMINI_API_KEY: "ambient-key",
  SPOTIFY_CLIENT_ID: "ambient-client",
};

// Set at module scope, not in a hook: setup files load before test files, so this lands *after*
// `setup-env.ts` captures its baseline and *before* its `beforeEach` runs — which is exactly where a
// real `.env` or an exported shell variable sits. Assigning these inside a test would prove nothing,
// since the isolation would already have run.
Object.assign(process.env, AMBIENT);

const configSrc = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "config.ts"),
  "utf8",
);

describe("test environment isolation", () => {
  it("hides an ambient Marquee setup, so the unconfigured path is testable on a real workstation", () => {
    const c = loadConfig();
    // The blunt version, and the one that actually matters: nothing the machine was configured with
    // reaches the resolved config. Asserting on named fields would have missed whichever field the
    // next leaked variable lands in — which is the whole failure mode being closed here.
    const resolved = JSON.stringify(c);
    for (const [name, value] of Object.entries(AMBIENT))
      // Quoted, so a short value can't match inside a key: bare `push` hits `"pushAssets"`, while
      // `"push"` only matches a leaked value.
      expect(resolved, `${name} leaked into the config`).not.toContain(
        JSON.stringify(value),
      );
    // The services that exist only when a URL is given must stay absent, or every "not configured"
    // test in the suite asserts against a real Pi.
    expect(c.backdrop).toBeUndefined();
    expect(c.amp).toBeUndefined();
    expect(c.stylus).toBeUndefined();
    expect(c.discogs).toBeUndefined();
    // Conductor is the exception: it always resolves, because the Demo Room proxy needs somewhere to
    // aim (see config.ts). What must be true is that it points at the localhost default and pushes
    // nothing — a push at a real address is how the 5s timeouts happened.
    expect(c.conductor?.url).toBe("http://localhost:4737");
    expect(c.conductor?.pushAssets).toBe(false);
  });

  it("keeps the cleared list complete as loadConfig learns new variables", () => {
    // The durable half. #32 made the isolation global so no test file could forget it, but left the
    // list hand-maintained — so the mechanism was right and the coverage was wrong. This reads the
    // source rather than trusting memory: a new `process.env.X` in config.ts that nobody adds to
    // CONFIG_ENV_VARS fails here, in CI, on the commit that introduced it.
    const read = [...configSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(
      (m) => m[1]!,
    );
    expect(read.length).toBeGreaterThan(0); // guard against the regex silently matching nothing
    const missing = [...new Set(read)].filter(
      (name) => !CONFIG_ENV_VARS.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it("lists nothing loadConfig doesn't actually read, so the list can't rot in the other direction", () => {
    const read = new Set(
      [...configSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!),
    );
    const stale = CONFIG_ENV_VARS.filter((name) => !read.has(name));
    expect(stale).toEqual([]);
  });
});
