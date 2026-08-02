// The guard that makes a silently-skipped CI run impossible. It is three lines of logic, but it is
// the only thing standing between "ffmpeg is installed" and "ffmpeg is installed *and we noticed
// when it stopped being*" — so it gets its own tests rather than being trusted by inspection.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { ffmpegGate } from "./ffmpeg-gate.js";

describe("ffmpegGate", () => {
  it("reports availability unchanged when ffmpeg is present", () => {
    expect(ffmpegGate(true, {})).toBe(true);
    expect(ffmpegGate(true, { MARQUEE_REQUIRE_FFMPEG: "1" })).toBe(true);
  });

  it("permits a silent skip on a workstation that hasn't installed ffmpeg", () => {
    // The default, and the reason the gate isn't simply an assertion: `pnpm test` must still pass
    // for a contributor who never touches video work.
    expect(ffmpegGate(false, {})).toBe(false);
  });

  it("turns a missing ffmpeg into a hard failure once CI declares it mandatory", () => {
    expect(() => ffmpegGate(false, { MARQUEE_REQUIRE_FFMPEG: "1" })).toThrow(
      /MARQUEE_REQUIRE_FFMPEG=1/,
    );
  });

  it("names the remedy in the message, since the failure is a harness problem not a test problem", () => {
    // Whoever hits this is looking at a red build with no code change behind it; the message has to
    // point at the workflow step rather than at the test that happened to trip first.
    expect(() => ffmpegGate(false, { MARQUEE_REQUIRE_FFMPEG: "1" })).toThrow(
      /\.github\/workflows\/ci\.yml/,
    );
  });

  it("only treats the exact opt-in value as mandatory", () => {
    // Guards the shape of the check itself: a truthy-string test would make MARQUEE_REQUIRE_FFMPEG=0
    // mean "required", which is the opposite of what anyone typing it intends.
    for (const value of ["0", "", "true", "yes"]) {
      expect(ffmpegGate(false, { MARQUEE_REQUIRE_FFMPEG: value })).toBe(false);
    }
  });
});

/**
 * The one CI leg that installs ffmpeg selects its files by filename substring
 * (`vitest run video-ffmpeg-integration card-art-print`), and vitest is happy as long as *some*
 * pattern matches something. So a rename, or a newly-added gated file nobody remembered to list,
 * would quietly shrink what the leg covers while it stayed green — the same silence this whole
 * change exists to end, one level up. This asserts the invariant directly: every file that resolves
 * the gate from the real environment is reachable from the script.
 *
 * A no-argument call is the marker precisely because it means "ask the real machine" — which is what
 * makes a file need the leg. This file is skipped by name rather than by that rule: prose about the
 * marker matches the marker, and the first draft duly reported itself as uncovered.
 */
describe("test:integration wiring", () => {
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts as Record<string, string>;

  it("runs every ffmpeg-gated test file on the leg that installs ffmpeg", () => {
    const here = new URL("./", import.meta.url);
    const self = import.meta.url.split("/").pop();
    const gated = readdirSync(here).filter(
      (name) =>
        name !== self &&
        name.endsWith(".test.ts") &&
        /ffmpegGate\(\)/.test(readFileSync(new URL(name, here), "utf8")),
    );
    // If this trips, the marker moved — fix the detection before trusting the assertion below.
    expect(gated.length).toBeGreaterThan(0);

    const prefix = "vitest run ";
    expect(scripts["test:integration"].startsWith(prefix)).toBe(true);
    const filters = scripts["test:integration"].slice(prefix.length).split(" ");

    const unreachable = gated.filter(
      (name) => !filters.some((f) => name.includes(f)),
    );
    expect(unreachable).toEqual([]);
  });

  it("does not let a filter rot into matching nothing", () => {
    const files = readdirSync(new URL("./", import.meta.url));
    const filters = scripts["test:integration"]
      .slice("vitest run ".length)
      .split(" ");
    for (const filter of filters) {
      expect(files.some((name) => name.includes(filter))).toBe(true);
    }
  });
});
