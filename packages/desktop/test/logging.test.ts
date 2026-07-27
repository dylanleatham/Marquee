import { describe, it, expect } from "vitest";
import { createShellLogger, formatRecord } from "../src/logging";

const at = (iso: string) => new Date(iso);

/** A sink + console pair that record what they were handed. */
const collector = () => {
  const written: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    sink: { write: (t: string) => written.push(t) },
    console: {
      log: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
    written,
    logs,
    warns,
    errors,
  };
};

describe("formatRecord", () => {
  it("stamps timestamp, level, and source onto the message", () => {
    expect(
      formatRecord(at("2026-07-27T12:34:56.789Z"), "error", "curator", "boom"),
    ).toBe("2026-07-27T12:34:56.789Z ERROR [curator] boom");
  });

  it("pads the level so records column-align when read as a file", () => {
    const info = formatRecord(
      at("2026-07-27T00:00:00.000Z"),
      "info",
      "shell",
      "up",
    );
    const error = formatRecord(
      at("2026-07-27T00:00:00.000Z"),
      "error",
      "shell",
      "up",
    );
    expect(info.indexOf("[shell]")).toBe(error.indexOf("[shell]"));
  });
});

describe("createShellLogger", () => {
  it("writes each record to the sink with a trailing newline", () => {
    const c = collector();
    const log = createShellLogger({
      sink: c.sink,
      console: c.console,
      now: () => at("2026-07-27T12:00:00.000Z"),
    });
    log.info("shell", "started");
    expect(c.written).toEqual([
      "2026-07-27T12:00:00.000Z INFO  [shell] started\n",
    ]);
  });

  it("mirrors to the console at the matching level — the dev terminal keeps working", () => {
    const c = collector();
    const log = createShellLogger({ sink: c.sink, console: c.console });
    log.info("shell", "i");
    log.warn("shell", "w");
    log.error("shell", "e");

    expect(c.logs).toHaveLength(1);
    expect(c.warns).toHaveLength(1);
    expect(c.errors).toHaveLength(1);
    expect(c.written).toHaveLength(3); // and all three still reach the file
  });

  it("logs a child stream line by line under its service name", () => {
    const c = collector();
    const log = createShellLogger({
      sink: c.sink,
      console: c.console,
      now: () => at("2026-07-27T12:00:00.000Z"),
    });
    const out = log.stream("info", "curator");

    out.push("listening on 4739\nready");
    expect(c.written).toEqual([
      "2026-07-27T12:00:00.000Z INFO  [curator] listening on 4739\n",
    ]);

    out.flush(); // the partial tail survives shutdown
    expect(c.written[1]).toBe(
      "2026-07-27T12:00:00.000Z INFO  [curator] ready\n",
    );
  });

  it("skips blank spacer lines from a chatty service", () => {
    const c = collector();
    const log = createShellLogger({ sink: c.sink, console: c.console });
    const out = log.stream("info", "curator");
    out.push("\n   \nreal line\n");
    expect(c.written).toHaveLength(1);
    expect(c.written[0]).toContain("real line");
  });

  it("scoped() binds a source, in the shape the renderer diagnostics expect", () => {
    const c = collector();
    const log = createShellLogger({
      sink: c.sink,
      console: c.console,
      now: () => at("2026-07-27T12:00:00.000Z"),
    });
    const renderer = log.scoped("renderer");
    renderer.error("process gone");
    renderer.warn("window became unresponsive");

    expect(c.written).toEqual([
      "2026-07-27T12:00:00.000Z ERROR [renderer] process gone\n",
      "2026-07-27T12:00:00.000Z WARN  [renderer] window became unresponsive\n",
    ]);
  });
});
