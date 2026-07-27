import { describe, it, expect, vi } from "vitest";
import { createLogger, consoleEmitter } from "../src/logger.js";
import type { LogRecord } from "../src/record.js";

const at = new Date("2026-07-27T20:00:00.000Z");

/** Collect records instead of writing them — the logger is a builder, not a transport. */
function collector() {
  const records: LogRecord[] = [];
  return { records, emit: (r: LogRecord) => records.push(r) };
}

describe("createLogger", () => {
  it("stamps every record with its service", () => {
    const { records, emit } = collector();
    const log = createLogger({ service: "curator", emit, now: () => at });
    log.info("listening");
    log.warn("slow");
    expect(records.map((r) => r.service)).toEqual(["curator", "curator"]);
  });

  it("routes each level through to the record", () => {
    const { records, emit } = collector();
    const log = createLogger({ service: "amp", emit, now: () => at });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => r.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("fingerprints the error handed to error()", () => {
    const { records, emit } = collector();
    const log = createLogger({ service: "amp", emit, now: () => at });
    log.error("Failed to start", new Error("boom"));
    expect(records[0]?.error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("attaches context when given", () => {
    const { records, emit } = collector();
    const log = createLogger({ service: "amp", emit, now: () => at });
    log.info("scan", { curatorId: "4f2a9c1b" });
    expect(records[0]?.context).toEqual({ curatorId: "4f2a9c1b" });
  });

  it("names a child as service:subsystem so one grep still finds the service", () => {
    const { records, emit } = collector();
    createLogger({ service: "curator", emit, now: () => at })
      .child("roadie")
      .info("step done");
    expect(records[0]?.service).toBe("curator:roadie");
  });

  it("keeps the parent's emitter and clock in a child", () => {
    const { records, emit } = collector();
    createLogger({ service: "curator", emit, now: () => at })
      .child("roadie")
      .info("x");
    expect(records[0]?.time).toBe(at.toISOString());
  });
});

describe("consoleEmitter", () => {
  const out = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("sends warn and error to their own console channels", () => {
    const { records, emit } = collector();
    const log = createLogger({ service: "amp", emit, now: () => at });
    log.info("i");
    log.warn("w");
    log.error("e");

    const console = out();
    const write = consoleEmitter(console, undefined);
    records.forEach(write);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("writes readable lines by default", () => {
    const console = out();
    consoleEmitter(
      console,
      undefined,
    )({
      level: "info",
      time: at.toISOString(),
      service: "amp",
      message: "up",
    });
    expect(console.log).toHaveBeenCalledWith(
      "2026-07-27T20:00:00.000Z INFO  [amp] up",
    );
  });

  it("writes JSON when MARQUEE_LOG_FORMAT=json, for whatever is parsing", () => {
    const console = out();
    const record: LogRecord = {
      level: "info",
      time: at.toISOString(),
      service: "amp",
      message: "up",
    };
    consoleEmitter(console, "json")(record);
    expect(JSON.parse(console.log.mock.calls[0][0] as string)).toEqual(record);
  });
});
