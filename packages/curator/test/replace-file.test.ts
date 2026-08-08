// Replacing a file Curator might also be serving (issue #255).
//
// The bug was Windows-only, so most of this file is meaningful on the `test:unit (windows-latest)`
// job and merely passes on Ubuntu — which is the point. That runner existed the whole time and had
// nothing to run, because no test ever replaced a file while holding it open.
import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  createReadStream,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceFile } from "../src/media/replace-file.js";

let dir: string;
const path = (name: string) => join(dir, name);

/** Hold `file` open the way `sendFile` does while the record page streams a clip. */
async function serving(file: string) {
  const rs = createReadStream(file);
  await new Promise((r) => rs.once("readable", r));
  return rs;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curator-replace-"));
});

describe("replaceFile", () => {
  it("replaces the destination and consumes the source", () => {
    writeFileSync(path("dest"), "old");
    writeFileSync(path("src"), "new");

    replaceFile(path("src"), path("dest"));

    expect(readFileSync(path("dest"), "utf8")).toBe("new");
    expect(existsSync(path("src"))).toBe(false);
  });

  it("works when the destination doesn't exist yet", () => {
    writeFileSync(path("src"), "new");
    replaceFile(path("src"), path("dest"));
    expect(readFileSync(path("dest"), "utf8")).toBe("new");
  });

  /**
   * The bug itself. On Windows a plain `renameSync` here throws
   * `EPERM: operation not permitted, rename` — that is what a user hit while the record page looped
   * the clip being replaced. On POSIX it simply succeeds, so this asserts the outcome rather than
   * the mechanism and is honest on both.
   */
  it("replaces a destination that is currently open for reading", async () => {
    writeFileSync(path("dest"), "old");
    writeFileSync(path("src"), "new");
    const reader = await serving(path("dest"));

    try {
      replaceFile(path("src"), path("dest"));
    } finally {
      reader.close();
    }

    expect(readFileSync(path("dest"), "utf8")).toBe("new");
    expect(existsSync(path("src"))).toBe(false);
  });

  /** The reader keeps reading the bytes it opened — unlinking a name doesn't disturb an open handle. */
  it("leaves the in-flight read intact", async () => {
    writeFileSync(path("dest"), "old");
    writeFileSync(path("src"), "new");
    const reader = await serving(path("dest"));

    replaceFile(path("src"), path("dest"));

    const chunks: Buffer[] = [];
    for await (const c of reader) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("old");
  });

  it("leaves nothing behind when it has to fall back", async () => {
    writeFileSync(path("dest"), "old");
    writeFileSync(path("src"), "new");
    const reader = await serving(path("dest"));
    try {
      replaceFile(path("src"), path("dest"));
    } finally {
      reader.close();
    }
    expect(readdirSync(dir).sort()).toEqual(["dest"]);
  });

  /**
   * A missing source is a real fault, not a locked destination. Papering over it with the unlink
   * fallback would destroy the destination and *then* fail — strictly worse than failing first.
   */
  it("throws for a genuine failure, without touching the destination", () => {
    writeFileSync(path("dest"), "old");

    expect(() => replaceFile(path("nope"), path("dest"))).toThrow();
    expect(readFileSync(path("dest"), "utf8")).toBe("old");
  });
});

/**
 * The durable gate (CLAUDE.md: close the blind spot, don't just fix the instance).
 *
 * The defect was one `renameSync` onto a path Curator also serves. Nothing stopped the next one, and
 * on the platform CI mostly runs it would look fine. So: the swap is defined once, and that
 * identifier is allowed to appear only in the module that defines it. A new call site has to go
 * through the helper or make this test red and argue with it.
 *
 * A plain text search, comments included — which means prose about it has to say "a bare rename"
 * instead. That is a small cost for a gate with no allowlist, no parser, and nothing to get subtly
 * wrong; an exception mechanism is the thing that would eventually let a real call site through.
 */
describe("renameSync lives in exactly one place (#255)", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(d, e.name))
        : e.name.endsWith(".ts")
          ? [join(d, e.name)]
          : [],
    );

  it("is used only by media/replace-file.ts", () => {
    const offenders = walk(srcDir).filter(
      (f) =>
        !f.endsWith(join("media", "replace-file.ts")) &&
        /\brenameSync\b/.test(readFileSync(f, "utf8")),
    );

    expect(
      offenders.map((f) => f.slice(srcDir.length)),
      "replace a file with `replaceFile` — a bare renameSync fails on Windows when the destination is being served (#255)",
    ).toEqual([]);
  });
});
