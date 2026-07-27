// The logger the services adopt (issue #142), so a record's shape is decided once rather than
// reinvented per service — four services had independently grown the same
// `console.error("Failed to start X:", err)` line.
//
// Deliberately not a transport. Where records go is the caller's business: the desktop shell has a
// rotating file sink (issue #141), a bare `pnpm dev` has a terminal, and tests have an array. The
// logger's job is to build a correct record and hand it over.
import {
  toRecord,
  formatJson,
  formatLine,
  type LogLevel,
  type LogRecord,
} from "./record.js";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  /** `error` is whatever `catch` gave you — Error, string, anything. */
  error(
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void;
  /** A logger for a subsystem of this service, e.g. `curator:roadie`. */
  child(subsystem: string): Logger;
}

export interface LoggerOptions {
  /** This service's name — `curator`, `conductor`, `amp`, `backdrop`. */
  service: string;
  /**
   * Where finished records go. Defaults to the console: JSON on stdout/stderr when
   * `MARQUEE_LOG_FORMAT=json`, otherwise the readable line.
   *
   * The shell captures its children's stdout (issue #144), so a service running under the desktop
   * app reaches the rotating file this way without needing its own sink.
   */
  emit?: (record: LogRecord) => void;
  now?: () => Date;
}

/** The console methods used, narrowed so tests can pass a collector. */
export interface ConsoleLike {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Default emitter: readable lines for a terminal, JSON when something is parsing.
 *
 * Format is env-driven rather than a build flag because the same binary runs both ways — a
 * developer's `pnpm dev` and the packaged app's supervised child are the same code.
 */
export function consoleEmitter(
  out: ConsoleLike = console,
  format: string | undefined = process.env.MARQUEE_LOG_FORMAT,
): (record: LogRecord) => void {
  const render = format === "json" ? formatJson : formatLine;
  return (record) => {
    const line = render(record);
    if (record.level === "error") out.error(line);
    else if (record.level === "warn") out.warn(line);
    else out.log(line);
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, emit = consoleEmitter(), now = () => new Date() } = options;

  const write = (
    level: LogLevel,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void => {
    emit(toRecord({ level, service, message, error, context, now: now() }));
  };

  return {
    debug: (message, context) => write("debug", message, undefined, context),
    info: (message, context) => write("info", message, undefined, context),
    warn: (message, context) => write("warn", message, undefined, context),
    error: (message, error, context) => write("error", message, error, context),
    // Subsystems read as `service:subsystem` rather than nesting a field, so one grep on the
    // service name still finds everything it emitted.
    child: (subsystem) =>
      createLogger({ ...options, service: `${service}:${subsystem}` }),
  };
}
