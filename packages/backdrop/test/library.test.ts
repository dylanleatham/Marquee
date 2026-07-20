import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Library } from "../src/library.js";
import { tempDataDir } from "./fakes.js";

const URI = "curator:album:2k7bxq9m";

describe("Library", () => {
  it("starts empty and resolves nothing", () => {
    const lib = new Library(tempDataDir());
    expect(lib.resolve(URI)).toBeUndefined();
    expect(lib.all().entries).toEqual({});
  });

  it("upserts, resolves, and persists to library.json", () => {
    const dir = tempDataDir();
    const lib = new Library(dir);
    lib.upsert(URI, { filePath: "/media/x.mp4", durationSec: 187 });
    expect(lib.resolve(URI)).toEqual({
      filePath: "/media/x.mp4",
      durationSec: 187,
    });

    // A fresh instance reads the same file back — the write survived the process.
    const reopened = new Library(dir);
    expect(reopened.resolve(URI)?.filePath).toBe("/media/x.mp4");
    const onDisk = JSON.parse(readFileSync(join(dir, "library.json"), "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.updatedAt).toBeTruthy();
  });

  it("replaceAll swaps the whole map", () => {
    const lib = new Library(tempDataDir());
    lib.upsert("a", { filePath: "/a.mp4" });
    lib.replaceAll({ b: { filePath: "/b.mp4" }, c: { filePath: "/c.mp4" } });
    expect(lib.resolve("a")).toBeUndefined();
    expect(lib.resolve("b")?.filePath).toBe("/b.mp4");
    expect(Object.keys(lib.all().entries)).toEqual(["b", "c"]);
  });

  it("remove reports whether the entry existed", () => {
    const lib = new Library(tempDataDir());
    lib.upsert(URI, { filePath: "/x.mp4" });
    expect(lib.remove(URI)).toBe(true);
    expect(lib.remove(URI)).toBe(false);
    expect(lib.resolve(URI)).toBeUndefined();
  });

  it("tolerates a corrupt library.json rather than crashing on boot", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "library.json"), "{ this is not json");
    const lib = new Library(dir);
    expect(lib.all().entries).toEqual({});
  });
});
