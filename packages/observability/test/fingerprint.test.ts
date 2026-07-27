import { describe, it, expect } from "vitest";
import {
  fingerprint,
  normalizeFramePath,
  parseStack,
  scrubMessage,
  toFingerprintInput,
} from "../src/fingerprint.js";

/** Build an Error with a stack we control, so these tests assert the algorithm and not V8. */
function errorWith(name: string, message: string, frames: string[]): Error {
  const err = new Error(message);
  err.name = name;
  err.stack = [`${name}: ${message}`, ...frames.map((f) => `    at ${f}`)].join(
    "\n",
  );
  return err;
}

const APP_FRAMES = [
  "startCurator (/home/dylan/Marquee/packages/curator/src/server.ts:2197:11)",
  "main (/home/dylan/Marquee/packages/curator/src/server.ts:2210:3)",
];

describe("normalizeFramePath", () => {
  it("makes a repo checkout path relative, so two machines agree", () => {
    expect(
      normalizeFramePath(
        "/home/dylan/Marquee/packages/curator/src/server.ts:2197:11",
      ),
    ).toBe("packages/curator/src/server.ts");
    expect(
      normalizeFramePath(
        "/opt/ci/build/packages/curator/src/server.ts:2197:11",
      ),
    ).toBe("packages/curator/src/server.ts");
  });

  it("normalizes a Windows path to the same value as its POSIX twin", () => {
    // The workstation is Windows and the Pi is Linux; one bug must not fingerprint twice.
    expect(
      normalizeFramePath(
        "D:\\a\\Marquee\\packages\\curator\\src\\server.ts:12:3",
      ),
    ).toBe(
      normalizeFramePath(
        "/home/dylan/Marquee/packages/curator/src/server.ts:12:3",
      ),
    );
  });

  it("strips the file:// URL form ESM stacks use", () => {
    expect(
      normalizeFramePath(
        "file:///home/dylan/Marquee/packages/amp/src/server.ts:5:1",
      ),
    ).toBe("packages/amp/src/server.ts");
  });

  it("drops pnpm's version-bearing path segment", () => {
    // Otherwise every dependency bump re-reports every known bug in that dependency as new.
    const before =
      "/repo/node_modules/.pnpm/fastify@5.1.0_abc123/node_modules/fastify/lib/route.js:10:3";
    const after =
      "/repo/node_modules/.pnpm/fastify@5.2.0_def456/node_modules/fastify/lib/route.js:10:3";
    expect(normalizeFramePath(before)).toBe(
      "node_modules/fastify/lib/route.js",
    );
    expect(normalizeFramePath(before)).toBe(normalizeFramePath(after));
  });

  it("drops line and column so editing above the throw site doesn't re-key the bug", () => {
    expect(normalizeFramePath("/repo/packages/amp/src/x.ts:10:3")).toBe(
      normalizeFramePath("/repo/packages/amp/src/x.ts:97:11"),
    );
  });
});

describe("parseStack", () => {
  it("reads both the named and the bare frame forms", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at foo (/repo/packages/amp/src/a.ts:1:1)",
        "    at /repo/packages/amp/src/b.ts:2:2",
      ].join("\n"),
    );
    expect(frames).toEqual([
      { fn: "foo", path: "packages/amp/src/a.ts" },
      { fn: "<anonymous>", path: "packages/amp/src/b.ts" },
    ]);
  });

  it("drops node internals — they describe V8's route, not the bug", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at foo (/repo/packages/amp/src/a.ts:1:1)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)",
      ].join("\n"),
    );
    expect(frames).toHaveLength(1);
  });

  it("treats async and plain spellings of a frame as the same frame", () => {
    const plain = parseStack(
      "Error: x\n    at run (/repo/packages/amp/src/a.ts:1:1)",
    );
    const asyncd = parseStack(
      "Error: x\n    at async run (/repo/packages/amp/src/a.ts:1:1)",
    );
    expect(plain).toEqual(asyncd);
  });
});

describe("fingerprint", () => {
  it("is identical for two occurrences of the same bug", () => {
    const a = errorWith("TypeError", "cannot read x of undefined", APP_FRAMES);
    const b = errorWith("TypeError", "cannot read x of undefined", APP_FRAMES);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("survives a different machine, a different checkout, and a different OS", () => {
    const linux = errorWith("TypeError", "boom", [
      "startCurator (/home/dylan/Marquee/packages/curator/src/server.ts:2197:11)",
    ]);
    const windows = errorWith("TypeError", "boom", [
      "startCurator (D:\\a\\Marquee\\Marquee\\packages\\curator\\src\\server.ts:2197:11)",
    ]);
    expect(fingerprint(linux)).toBe(fingerprint(windows));
  });

  it("ignores the message, so one bug doesn't split across its variable parts", () => {
    // The whole point: "album 4f2a failed" and "album 9c81 failed" are one bug, not two.
    const a = errorWith(
      "Error",
      "album 4f2a failed after 3 retries",
      APP_FRAMES,
    );
    const b = errorWith(
      "Error",
      "album 9c81 failed after 11 retries",
      APP_FRAMES,
    );
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("survives an edit that moves the throw site within its file", () => {
    const before = errorWith("Error", "boom", [
      "startCurator (/repo/packages/curator/src/server.ts:2197:11)",
    ]);
    const after = errorWith("Error", "boom", [
      "startCurator (/repo/packages/curator/src/server.ts:2244:11)",
    ]);
    expect(fingerprint(before)).toBe(fingerprint(after));
  });

  it("separates different error types raised from the same place", () => {
    const type = errorWith("TypeError", "boom", APP_FRAMES);
    const range = errorWith("RangeError", "boom", APP_FRAMES);
    expect(fingerprint(type)).not.toBe(fingerprint(range));
  });

  it("separates the same error type raised from different places", () => {
    const here = errorWith("Error", "boom", [
      "a (/repo/packages/curator/src/one.ts:1:1)",
    ]);
    const there = errorWith("Error", "boom", [
      "b (/repo/packages/curator/src/two.ts:1:1)",
    ]);
    expect(fingerprint(here)).not.toBe(fingerprint(there));
  });

  it("separates two call sites that share a helper", () => {
    // Same top frame, different callers — the depth window is what keeps these apart.
    const viaA = errorWith("Error", "boom", [
      "assertReady (/repo/packages/curator/src/util.ts:5:1)",
      "handleScan (/repo/packages/curator/src/scan.ts:20:3)",
    ]);
    const viaB = errorWith("Error", "boom", [
      "assertReady (/repo/packages/curator/src/util.ts:5:1)",
      "handleSync (/repo/packages/curator/src/sync.ts:40:3)",
    ]);
    expect(fingerprint(viaA)).not.toBe(fingerprint(viaB));
  });

  it("keys on our frames, not the dependency's, when both are present", () => {
    // A fastify internal reached from two of our call sites is two bugs, not one.
    const deep =
      "route (/repo/node_modules/.pnpm/fastify@5.1.0_x/node_modules/fastify/lib/r.js:1:1)";
    const fromScan = errorWith("Error", "boom", [
      deep,
      "scan (/repo/packages/amp/src/scan.ts:2:2)",
    ]);
    const fromPlay = errorWith("Error", "boom", [
      deep,
      "play (/repo/packages/amp/src/play.ts:2:2)",
    ]);
    expect(fingerprint(fromScan)).not.toBe(fingerprint(fromPlay));
  });

  it("falls back to dependency frames when the stack has none of ours", () => {
    const a = errorWith("Error", "boom", [
      "route (/repo/node_modules/.pnpm/fastify@5.1.0_x/node_modules/fastify/lib/r.js:1:1)",
    ]);
    const b = errorWith("Error", "boom", [
      "parse (/repo/node_modules/.pnpm/fastify@5.1.0_x/node_modules/fastify/lib/parse.js:1:1)",
    ]);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("does not collapse every stackless failure into one id", () => {
    // Without the scrubbed-message fallback these would all share a fingerprint, and a reporter
    // would file the first one and silently swallow the rest.
    expect(fingerprint("spotify token expired")).not.toBe(
      fingerprint("hue bridge unreachable"),
    );
  });

  it("still groups one stackless failure across its variable parts", () => {
    expect(fingerprint("album 4f2a failed in 12ms")).toBe(
      fingerprint("album 9c81 failed in 87ms"),
    );
  });

  it("handles anything catch can produce without throwing", () => {
    for (const value of [
      undefined,
      null,
      42,
      "boom",
      { code: "EACCES" },
      new Error("x"),
    ]) {
      expect(fingerprint(value)).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("survives a circular thrown object", () => {
    const circular: Record<string, unknown> = { code: "EACCES" };
    circular.self = circular;
    expect(fingerprint(circular)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("toFingerprintInput", () => {
  it("keeps a subclass's own name so it groups separately", () => {
    class PaletteNotReadyError extends Error {
      override name = "PaletteNotReadyError";
    }
    expect(toFingerprintInput(new PaletteNotReadyError("x")).name).toBe(
      "PaletteNotReadyError",
    );
  });
});

describe("scrubMessage", () => {
  it("removes the parts that vary between occurrences", () => {
    expect(scrubMessage("album 4f2a9c1b failed after 3 retries")).toBe(
      "album <id> failed after <n> retries",
    );
    expect(scrubMessage("ENOENT: /home/dylan/x/y.json missing")).toBe(
      "ENOENT: <path> missing",
    );
  });

  it("leaves ordinary prose alone, so different failures stay different", () => {
    expect(scrubMessage("spotify token expired")).toBe("spotify token expired");
  });
});
