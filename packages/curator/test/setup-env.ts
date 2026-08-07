import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { CONFIG_ENV_VARS } from "../src/config.js";

// Global environment isolation for every curator test (registered via vitest `setupFiles`).
//
// buildServer → loadConfig resolves its whole configuration from config.toml, then env vars, then
// settings.json in the data dir — and a real workstation has all three. Without isolation, tests
// that assert the *unconfigured* path pick up a developer's actual setup and fail on their machine
// while passing on a clean CI box (issue #32).
//
// Point the data dir at a fresh empty temp dir and drop every variable loadConfig reads, so no test
// file can accidentally see ambient machine state. Restore the environment afterwards. This is
// deliberately global rather than a per-file `beforeEach`: a per-file block is easy to forget in the
// next test file that builds a server (which is exactly how #32 slipped past #26's fix).
//
// The list is `CONFIG_ENV_VARS`, owned by config.ts, rather than written out here — #32 hand-wrote
// three names while loadConfig read twenty-nine, so the other twenty-six leaked and the suite failed
// 49 tests locally that CI was green on (issue #247). `env-isolation.test.ts` fails if the list and
// the source ever drift. The mechanism was never the problem; the coverage was.
const savedEnv = { ...process.env };

beforeEach(() => {
  for (const name of CONFIG_ENV_VARS) delete process.env[name];
  // After the sweep, not before — MARQUEE_DATA_DIR is itself on the list.
  process.env.MARQUEE_DATA_DIR = mkdtempSync(join(tmpdir(), "curator-test-"));
});

afterEach(() => {
  process.env = { ...savedEnv };
});
