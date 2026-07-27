// Structured log records and stable error fingerprints (issue #142) — stage 2 of the error
// observability pipeline (issue #144). Pure: no I/O, no transport, no dependencies.
export {
  fingerprint,
  normalizeFramePath,
  parseStack,
  scrubMessage,
  toFingerprintInput,
  type FingerprintInput,
  type StackFrame,
} from "./fingerprint.js";
export {
  toRecord,
  formatJson,
  formatLine,
  type ErrorRecord,
  type LogLevel,
  type LogRecord,
  type RecordInput,
} from "./record.js";
export {
  createLogger,
  consoleEmitter,
  type ConsoleLike,
  type Logger,
  type LoggerOptions,
} from "./logger.js";
