import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSpotifyTokens,
  writeSpotifyTokens,
  clearSpotifyTokens,
} from "../src/spotify/token-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "curator-tok-"));

describe("spotify token-store", () => {
  it("round-trips the refresh token + scope", () => {
    const d = dir();
    writeSpotifyTokens(d, {
      refreshToken: "refresh-abc",
      scope: "streaming user-read-playback-state",
      obtainedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(readSpotifyTokens(d)).toEqual({
      refreshToken: "refresh-abc",
      scope: "streaming user-read-playback-state",
      obtainedAt: "2026-07-19T00:00:00.000Z",
    });
    // Kept out of settings.json (its own file), so the human-edited settings keep a single writer.
    expect(existsSync(join(d, "spotify-tokens.json"))).toBe(true);
    expect(existsSync(join(d, "settings.json"))).toBe(false);
  });

  it("returns undefined when absent", () => {
    expect(readSpotifyTokens(dir())).toBeUndefined();
  });

  it("returns undefined for malformed JSON or a missing refresh token", () => {
    const d = dir();
    writeFileSync(join(d, "spotify-tokens.json"), "{ not json");
    expect(readSpotifyTokens(d)).toBeUndefined();

    writeFileSync(
      join(d, "spotify-tokens.json"),
      JSON.stringify({ scope: "x" }),
    );
    expect(readSpotifyTokens(d)).toBeUndefined();
  });

  it("clears the tokens (and is a no-op when absent)", () => {
    const d = dir();
    writeSpotifyTokens(d, {
      refreshToken: "r",
      scope: "",
      obtainedAt: "2026-07-19T00:00:00.000Z",
    });
    clearSpotifyTokens(d);
    expect(readSpotifyTokens(d)).toBeUndefined();
    expect(() => clearSpotifyTokens(d)).not.toThrow();
  });
});
