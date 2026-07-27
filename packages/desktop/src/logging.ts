// The shell's logger: one timestamped record per line, written to the rotating file sink *and* the
// console (issue #141).
//
// Both destinations, not one. The file is the point — it's the only thing that survives a Start-menu
// launch — but a `pnpm app` dev run still wants its terminal output, and losing it would trade one
// blind spot for another.
//
// Record shape here is deliberately minimal: `<ISO timestamp> <LEVEL> [source] message`. Turning
// that into structured records with stable error fingerprints is issue #142; this stage is about
// having a destination at all.
import { createLineWriter, type LogSink } from "./log-sink";

export type LogLevel = "info" | "warn" | "error";

export interface ShellLogger {
  /** One complete record. `source` is the service or subsystem, e.g. `curator`, `renderer`. */
  log(level: LogLevel, source: string, message: string): void;
  info(source: string, message: string): void;
  warn(source: string, message: string): void;
  error(source: string, message: string): void;
  /**
   * A writer for a child process's raw stdout/stderr. Chunks are framed into whole lines, each
   * logged under `source` at `level`. Call `flush()` when the stream ends.
   */
  stream(
    level: LogLevel,
    source: string,
  ): { push(chunk: string): void; flush(): void };
  /** This logger bound to one source, in the shape `registerRendererDiagnostics` expects. */
  scoped(source: string): {
    warn(message: string): void;
    error(message: string): void;
  };
}

/** The console methods used, narrowed so tests can pass a collector. */
export interface ConsoleLike {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The sink surface the logger needs — `createLogSink`'s result satisfies it structurally. */
export type LogWriter = Pick<LogSink, "write">;

export function formatRecord(
  timestamp: Date,
  level: LogLevel,
  source: string,
  message: string,
): string {
  return `${timestamp.toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`;
}

export interface ShellLoggerOptions {
  sink: LogWriter;
  console?: ConsoleLike;
  /** Injectable clock so record formatting is testable without freezing real time. */
  now?: () => Date;
}

export function createShellLogger(options: ShellLoggerOptions): ShellLogger {
  const { sink, console: out = console, now = () => new Date() } = options;

  const log = (level: LogLevel, source: string, message: string): void => {
    const record = formatRecord(now(), level, source, message);
    sink.write(`${record}\n`);
    if (level === "error") out.error(record);
    else if (level === "warn") out.warn(record);
    else out.log(record);
  };

  return {
    log,
    info: (source, message) => log("info", source, message),
    warn: (source, message) => log("warn", source, message),
    error: (source, message) => log("error", source, message),
    stream: (level, source) =>
      createLineWriter((line) => {
        if (line.trim() === "") return; // a service's blank spacer lines aren't records
        log(level, source, line);
      }),
    scoped: (source) => ({
      warn: (message) => log("warn", source, message),
      error: (message) => log("error", source, message),
    }),
  };
}
