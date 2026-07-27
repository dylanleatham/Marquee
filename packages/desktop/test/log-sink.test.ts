import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogSink, createLineWriter, rotatedName } from "../src/log-sink";

// Against a real temp dir rather than a mocked fs: rotation is a sequence of renames and deletes,
// and the thing worth asserting is what ends up on disk — a mock would only assert my own plan.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marquee-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (name: string): string => readFileSync(join(dir, name), "utf8");

describe("rotatedName", () => {
  it("inserts the index before the extension", () => {
    expect(rotatedName("marquee.log", 3)).toBe("marquee.3.log");
  });

  it("appends the index when there is no extension", () => {
    expect(rotatedName("marquee", 2)).toBe("marquee.2");
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    expect(rotatedName(".marquee", 1)).toBe(".marquee.1");
  });
});

describe("createLogSink", () => {
  it("creates the directory and appends what it is given", () => {
    const nested = join(dir, "deep", "logs");
    const sink = createLogSink({ dir: nested });
    sink.write("one\n");
    sink.write("two\n");
    sink.close();
    expect(readFileSync(join(nested, "marquee.log"), "utf8")).toBe(
      "one\ntwo\n",
    );
  });

  it("resumes an existing file instead of truncating it", () => {
    writeFileSync(join(dir, "marquee.log"), "from a previous run\n");
    const sink = createLogSink({ dir });
    sink.write("from this run\n");
    sink.close();
    expect(read("marquee.log")).toBe("from a previous run\nfrom this run\n");
  });

  it("rotates once the file would exceed maxBytes, keeping whole lines together", () => {
    const sink = createLogSink({ dir, maxBytes: 12, maxFiles: 3 });
    sink.write("aaaa\n"); // 5 bytes
    sink.write("bbbb\n"); // 10 — still fits
    sink.write("cccc\n"); // would be 15 → rotate first
    sink.close();

    expect(read("marquee.log")).toBe("cccc\n");
    expect(read("marquee.1.log")).toBe("aaaa\nbbbb\n"); // never split mid-line
  });

  it("ages files out at maxFiles rather than growing without bound", () => {
    const sink = createLogSink({ dir, maxBytes: 5, maxFiles: 3 });
    for (const line of ["one\n", "two\n", "three\n", "four\n"])
      sink.write(line);
    sink.close();

    // Newest lives in the base name; each rotation pushes the rest down; the oldest is deleted.
    expect(readdirSync(dir).sort()).toEqual([
      "marquee.1.log",
      "marquee.2.log",
      "marquee.log",
    ]);
    expect(read("marquee.log")).toBe("four\n");
    expect(read("marquee.1.log")).toBe("three\n");
    expect(read("marquee.2.log")).toBe("two\n");
  });

  it("keeps only the live file when maxFiles is 1", () => {
    const sink = createLogSink({ dir, maxBytes: 5, maxFiles: 1 });
    sink.write("one\n");
    sink.write("two\n");
    sink.close();
    expect(readdirSync(dir)).toEqual(["marquee.log"]);
    expect(read("marquee.log")).toBe("two\n");
  });

  it("writes a line longer than maxBytes rather than rotating forever", () => {
    const sink = createLogSink({ dir, maxBytes: 4, maxFiles: 2 });
    sink.write("a stack trace far longer than the limit\n");
    sink.close();
    expect(read("marquee.log")).toBe(
      "a stack trace far longer than the limit\n",
    );
  });

  it("drops writes after close, and closing twice is harmless", () => {
    const sink = createLogSink({ dir });
    sink.write("kept\n");
    sink.close();
    sink.close();
    sink.write("dropped\n");
    expect(read("marquee.log")).toBe("kept\n");
  });

  it("honours a custom base name for both the live and rotated files", () => {
    const sink = createLogSink({
      dir,
      baseName: "shell.txt",
      maxBytes: 5,
      maxFiles: 2,
    });
    sink.write("one\n");
    sink.write("two\n");
    sink.close();
    expect(readdirSync(dir).sort()).toEqual(["shell.1.txt", "shell.txt"]);
  });
});

describe("createLineWriter", () => {
  it("emits only complete lines, holding a partial one until its newline arrives", () => {
    const lines: string[] = [];
    const writer = createLineWriter((l) => lines.push(l));

    writer.push("hello wo");
    expect(lines).toEqual([]); // a chunk boundary mid-line must not become a record

    writer.push("rld\n");
    expect(lines).toEqual(["hello world"]);
  });

  it("splits a chunk carrying several lines", () => {
    const lines: string[] = [];
    const writer = createLineWriter((l) => lines.push(l));
    writer.push("one\ntwo\nthree\n");
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("strips the carriage return of a CRLF child", () => {
    const lines: string[] = [];
    const writer = createLineWriter((l) => lines.push(l));
    writer.push("windows line\r\n");
    expect(lines).toEqual(["windows line"]);
  });

  it("caps a newline-free run instead of buffering it without bound", () => {
    const lines: string[] = [];
    const writer = createLineWriter((l) => lines.push(l));

    // A service emitting a progress bar with \r, or something binary — no newline ever arrives.
    writer.push("x".repeat(150 * 1024));

    // Two full 64 KiB records emitted; the remainder still waits for its newline.
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length === 64 * 1024)).toBe(true);
    writer.flush();
    expect(lines[2]).toHaveLength(150 * 1024 - 2 * 64 * 1024);
  });

  it("flush emits a buffered partial line, and is a no-op when nothing is buffered", () => {
    const lines: string[] = [];
    const writer = createLineWriter((l) => lines.push(l));

    writer.push("no trailing newline");
    writer.flush();
    expect(lines).toEqual(["no trailing newline"]);

    writer.flush();
    expect(lines).toHaveLength(1); // flushing again must not repeat the line
  });
});
