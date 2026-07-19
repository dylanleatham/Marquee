import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Guards the global credential isolation (vitest `setupFiles`). Without it, curator server tests
// fall back through loadConfig to the developer's real ~/marquee/settings.json and become
// machine-dependent — green on a clean CI box, red on any machine with Spotify/Gemini configured
// (issue #32). This assertion is deterministic on every machine: it checks the isolation is in
// place, not any real credential behavior.
describe("test credential isolation", () => {
  it("clears ambient Spotify/Gemini creds and points the data dir at an empty temp dir", () => {
    expect(process.env.SPOTIFY_CLIENT_ID).toBeUndefined();
    expect(process.env.SPOTIFY_CLIENT_SECRET).toBeUndefined();
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    const dir = process.env.MARQUEE_DATA_DIR;
    expect(dir).toBeTruthy();
    expect(existsSync(join(dir!, "settings.json"))).toBe(false);
  });
});
