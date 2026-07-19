import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";

// Global credential isolation for every curator test (registered via vitest `setupFiles`).
//
// buildServer → loadConfig resolves Spotify/Gemini credentials from config.toml, then env vars,
// then settings.json in the data dir — and the packaged app writes real creds to
// ~/marquee/settings.json. Without isolation, tests that assert the *unconfigured* path pick up a
// developer's actual setup and fail on their machine while passing on a clean CI box (issue #32).
//
// Point the data dir at a fresh empty temp dir and drop the credential env vars before each test, so
// no test file can accidentally read ambient machine state. Restore the environment afterwards.
// This is deliberately global rather than a per-file `beforeEach`: a per-file block is easy to forget
// in the next test file that builds a server (which is exactly how #32 slipped past #26's fix).
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.MARQUEE_DATA_DIR = mkdtempSync(join(tmpdir(), "curator-test-"));
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});
