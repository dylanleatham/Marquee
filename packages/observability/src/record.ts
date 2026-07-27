// The structured log record every service emits (issue #142).
//
// Two representations of one record, because the audiences differ and neither is optional: a JSON
// line for anything automated (the rotating sink from issue #141, and the reporter in #143), and a
// readable line for a terminal. Issue #141's shell logger already made that point for unstructured
// text; this keeps it true once the records have structure.
import { fingerprint, toFingerprintInput } from "./fingerprint.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ErrorRecord {
  name: string;
  message: string;
  stack?: string;
  /** Groups occurrences of one bug. See fingerprint.ts for what "one bug" means here. */
  fingerprint: string;
}

export interface LogRecord {
  level: LogLevel;
  /** ISO-8601 UTC. */
  time: string;
  /** Which service or subsystem emitted this — `curator`, `conductor`, `renderer`. */
  service: string;
  message: string;
  /** Present only on records that carry a failure. */
  error?: ErrorRecord;
  /** Anything else worth attaching. Kept flat so a JSON line stays greppable. */
  context?: Record<string, unknown>;
}

export interface RecordInput {
  level: LogLevel;
  service: string;
  message: string;
  /** Anything `catch` produced. Coerced — it does not have to be an Error. */
  error?: unknown;
  context?: Record<string, unknown>;
  /** Injectable so record building is testable without freezing real time. */
  now?: Date;
}

export function toRecord(input: RecordInput): LogRecord {
  const { level, service, message, error, context, now = new Date() } = input;
  const record: LogRecord = {
    level,
    time: now.toISOString(),
    service,
    message,
  };
  if (error !== undefined) {
    const { name, message: errMessage, stack } = toFingerprintInput(error);
    record.error = {
      name,
      message: errMessage,
      ...(stack === undefined ? {} : { stack }),
      fingerprint: fingerprint(error),
    };
  }
  if (context !== undefined) record.context = context;
  return record;
}

/** The machine-readable form: one JSON object per line, for the file sink and the reporter. */
export const formatJson = (record: LogRecord): string => JSON.stringify(record);

/**
 * The human-readable form. Matches the shape issue #141 established for the shell
 * (`<ISO> <LEVEL> [source] message`) so a log file stays scannable, with the error name, the
 * fingerprint, and the stack appended when there is one.
 *
 * The fingerprint is shown because it is the handle: it is what you grep for to find every other
 * occurrence, and what a filed issue is keyed on.
 */
export function formatLine(record: LogRecord): string {
  const head = `${record.time} ${record.level.toUpperCase().padEnd(5)} [${record.service}] ${record.message}`;
  if (!record.error) return head;
  const { name, message, stack, fingerprint: fp } = record.error;
  const summary = `${head} — ${name}: ${message} (${fp})`;
  return stack ? `${summary}\n${stack}` : summary;
}
