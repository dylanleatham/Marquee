import { describe, it, expect } from "vitest";
import { toRecord, formatJson, formatLine } from "../src/record.js";
import { fingerprint } from "../src/fingerprint.js";

const at = new Date("2026-07-27T20:00:00.000Z");

describe("toRecord", () => {
  it("carries level, ISO time, service and message", () => {
    expect(
      toRecord({
        level: "info",
        service: "curator",
        message: "listening",
        now: at,
      }),
    ).toEqual({
      level: "info",
      time: "2026-07-27T20:00:00.000Z",
      service: "curator",
      message: "listening",
    });
  });

  it("omits error and context rather than emitting nulls", () => {
    // A JSON line is grepped and eyeballed; empty keys are noise on every non-error record.
    const record = toRecord({
      level: "info",
      service: "amp",
      message: "up",
      now: at,
    });
    expect("error" in record).toBe(false);
    expect("context" in record).toBe(false);
  });

  it("attaches name, message, stack and fingerprint for an error", () => {
    const err = new Error("boom");
    const record = toRecord({
      level: "error",
      service: "curator",
      message: "Failed to start",
      error: err,
      now: at,
    });
    expect(record.error?.name).toBe("Error");
    expect(record.error?.message).toBe("boom");
    expect(record.error?.stack).toContain("boom");
    expect(record.error?.fingerprint).toBe(fingerprint(err));
  });

  it("accepts a non-Error throw without losing the record", () => {
    const record = toRecord({
      level: "error",
      service: "amp",
      message: "Failed",
      error: "sonos said no",
      now: at,
    });
    expect(record.error?.name).toBe("thrown");
    expect(record.error?.message).toBe("sonos said no");
    expect(record.error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("formatJson", () => {
  it("emits one parseable line with no embedded newline outside the stack", () => {
    const record = toRecord({
      level: "warn",
      service: "amp",
      message: "slow",
      now: at,
    });
    const line = formatJson(record);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(record);
  });
});

describe("formatLine", () => {
  it("matches the shape issue #141 established for the shell", () => {
    expect(toLine("info", "curator", "listening")).toBe(
      "2026-07-27T20:00:00.000Z INFO  [curator] listening",
    );
  });

  it("pads the level so the columns line up when scanning a file", () => {
    expect(toLine("warn", "amp", "x")).toContain("WARN  [amp]");
    expect(toLine("error", "amp", "x")).toContain("ERROR [amp]");
  });

  it("shows the fingerprint, because it's the handle for finding the other occurrences", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (/repo/packages/amp/src/a.ts:1:1)";
    const line = formatLine(
      toRecord({
        level: "error",
        service: "amp",
        message: "Failed",
        error: err,
        now: at,
      }),
    );
    expect(line).toContain(`(${fingerprint(err)})`);
    expect(line).toContain("Error: boom");
    expect(line).toContain("packages/amp/src/a.ts");
  });
});

const toLine = (
  level: "info" | "warn" | "error",
  service: string,
  message: string,
): string => formatLine(toRecord({ level, service, message, now: at }));
