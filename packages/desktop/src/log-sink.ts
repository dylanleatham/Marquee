// A rotating file sink for the desktop shell's merged log stream (issue #141).
//
// Everything the shell logs — each child service's stdout/stderr (main.ts), renderer diagnostics
// (crash-log.ts), and the failures that raise a dialog — went to `process.stdout`/`process.stderr`.
// Launched from the Start menu rather than a terminal, that stream has no destination, so an error
// hit while using the app left no trace once its dialog was dismissed. This gives it one.
//
// Kept free of any Electron import so it unit-tests against a temp dir without booting Electron;
// main.ts supplies the real `app.getPath("logs")`.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** 5 MiB per file — a few weeks of an idle app, minutes of a service in a crash loop. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Current file + 4 rotated. Bounded retention: an always-on machine must not fill its disk. */
const DEFAULT_MAX_FILES = 5;
const DEFAULT_BASE_NAME = "marquee.log";

export interface LogSinkOptions {
  /** Directory to write into; created (recursively) if absent. */
  dir: string;
  /** Name of the live file. Rotated siblings get `.1`, `.2`, … before the extension. */
  baseName?: string;
  /** Rotate once the live file would exceed this many bytes. */
  maxBytes?: number;
  /** Total files kept, live one included. The oldest is deleted, not archived. */
  maxFiles?: number;
}

export interface LogSink {
  /** Absolute path of the live log file — what the "Open log folder" menu item reveals. */
  readonly file: string;
  /** Append text verbatim. Never throws: a failed log write must not take the app down. */
  write(text: string): void;
  /** Release the file handle. Idempotent. */
  close(): void;
}

/** `marquee.log` → `marquee.3.log`; a name with no extension → `marquee.3`. */
export function rotatedName(baseName: string, index: number): string {
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0) return `${baseName}.${index}`;
  return `${baseName.slice(0, dot)}.${index}${baseName.slice(dot)}`;
}

/**
 * Open (or create) a size-rotating log file in `dir`.
 *
 * Writes are **synchronous** on purpose. The whole point of this sink is the crash case, and a
 * buffered async stream drops exactly the tail you came looking for when the process dies. Volume
 * here is a handful of lines per second at worst, and a local synchronous append costs microseconds.
 */
export function createLogSink(options: LogSinkOptions): LogSink {
  const {
    dir,
    baseName = DEFAULT_BASE_NAME,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
  } = options;
  const file = join(dir, baseName);

  mkdirSync(dir, { recursive: true });

  let fd: number | null = null;
  let size = 0;
  /** Set only by `close()`. Distinguishes "deliberately shut" from "handle transiently lost", which
   * must self-heal — conflating the two is how one failed rotation silenced the log for good. */
  let closed = false;
  /** Size at which the next rotation is attempted. Raised after a *failed* rotation so a filesystem
   * that won't cooperate is retried occasionally instead of on every single record. */
  let rotateAt = maxBytes;

  const open = (): void => {
    fd = openSync(file, "a"); // creates it if absent
    size = statSync(file).size; // resume an existing file rather than restarting its budget
  };

  /**
   * Shift `marquee.log` → `.1` → `.2` → … dropping whatever falls off the end. Walking downwards
   * from the oldest means each rename lands on a free (or doomed) slot, so no temp names are needed.
   *
   * The shuffle is **best-effort**; reopening afterwards is not. A rename or delete here can fail for
   * reasons that have nothing to do with this app — antivirus or a previous instance holding a rotated
   * sibling open is routine on Windows. When that happened the throw escaped to `write()`'s catch with
   * `fd` already nulled, and every later record was dropped in silence for the life of the process.
   * Losing the whole log to protect its size cap is exactly the wrong trade, so a failed shuffle keeps
   * the current file and lets it grow.
   */
  const rotate = (): void => {
    if (fd !== null) {
      closeSync(fd);
      fd = null;
    }
    try {
      // maxFiles <= 1 keeps only the live file: truncate rather than rotate.
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = i === 1 ? file : join(dir, rotatedName(baseName, i - 1));
        const to = join(dir, rotatedName(baseName, i));
        if (!existsSync(from)) continue;
        if (i === maxFiles - 1) rmSync(to, { force: true }); // the one aging out
        renameSync(from, to);
      }
      if (maxFiles <= 1) rmSync(file, { force: true });
    } catch {
      // Keep whatever the shuffle managed; `open()` below is what actually matters.
    }
    open();
    // Rotation worked → size is 0 → back to the normal cap. It didn't → aim a full cap beyond where
    // we already are, so the next attempt is one cap away rather than on the very next write.
    rotateAt = size + maxBytes;
  };

  open();

  return {
    file,
    write(text: string): void {
      try {
        if (closed) return; // deliberately shut — don't resurrect the handle
        if (fd === null) open(); // handle lost to an earlier failure: take it back
        const bytes = Buffer.byteLength(text);
        // Rotate *before* writing so a single line is never split across two files.
        if (size > 0 && size + bytes > rotateAt) rotate();
        if (fd === null) return;
        writeSync(fd, text);
        size += bytes;
      } catch {
        // A full disk or a revoked handle must not crash the shell — logging is best-effort. The
        // next write retries `open()`, so a transient failure costs records, not the sink.
      }
    },
    close(): void {
      closed = true;
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
      fd = null;
    },
  };
}

/** One rejected log directory and why — carried so the shell can say where it tried. */
export interface LogDirFailure {
  dir: string;
  error: string;
}

export interface OpenedLogSink {
  sink: LogSink;
  /** The directory that accepted the sink — what "Open log folder" must reveal. */
  dir: string;
  /** Directories tried and rejected before this one. Empty on the happy path. */
  failures: LogDirFailure[];
}

/**
 * Open a sink in the first of `dirs` that will take one.
 *
 * The shell's preferred directory (`app.getPath("logs")`) can be unavailable for reasons the app
 * can't fix — an offline roaming profile, locked-down permissions, a stale handle. The old behaviour
 * was to fall back to "console only", which from a Start-menu launch means **no destination at all**:
 * the app runs happily and logs nothing, and an empty log folder is indistinguishable from a quiet
 * evening. A second candidate under the temp dir is worth far more than that.
 *
 * `make` is injectable so this is tested without touching a real protected directory.
 *
 * @throws an Error naming every directory tried and why each was rejected, when none works.
 */
export function openLogSink(
  dirs: string[],
  make: (options: LogSinkOptions) => LogSink = createLogSink,
): OpenedLogSink {
  const failures: LogDirFailure[] = [];
  for (const dir of dirs) {
    try {
      return { sink: make({ dir }), dir, failures };
    } catch (err) {
      failures.push({ dir, error: (err as Error).message });
    }
  }
  const summary = failures.map((f) => `${f.dir} (${f.error})`).join("; ");
  throw new Error(
    `no writable log directory — tried ${summary || "nothing: no candidates given"}`,
  );
}

/**
 * Longest run of newline-free output held before it is emitted anyway. A child that writes a
 * progress bar with `\r`, or dumps something binary, otherwise grows this buffer without limit —
 * the desktop shell is always-on, so an unbounded accumulator is a slow memory leak waiting for the
 * wrong service to misbehave. Cut the record instead; a truncated line beats a swollen process.
 */
const MAX_PENDING_CHARS = 64 * 1024;

/**
 * Frame a stream of arbitrary chunks into whole lines, each passed to `emit`.
 *
 * A child process's stdout arrives in whatever sizes the pipe hands over — half a line, three lines,
 * a line split mid-word. Prefixing chunks directly would stamp the middle of a message and leave the
 * rest unattributed, so the tail of an incomplete line is held until its newline shows up (or until
 * `MAX_PENDING_CHARS` says it never will).
 */
export function createLineWriter(emit: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = "";
  return {
    push(chunk: string): void {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        // Trailing \r too: a Windows child's CRLF would otherwise land mid-file as a stray return.
        emit(pending.slice(0, nl).replace(/\r$/, ""));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      while (pending.length > MAX_PENDING_CHARS) {
        emit(pending.slice(0, MAX_PENDING_CHARS));
        pending = pending.slice(MAX_PENDING_CHARS);
      }
    },
    /** Emit whatever is buffered without its newline — for shutdown, so a last partial line survives. */
    flush(): void {
      if (pending === "") return;
      emit(pending);
      pending = "";
    },
  };
}
