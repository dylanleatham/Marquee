// Stable per-error fingerprints (issue #142).
//
// This is the load-bearing piece of the error pipeline. Without it a reporter cannot tell "the same
// bug for the 40th time" from "a new bug", so it either spams duplicates or drops real failures.
//
// The bar is two-sided and in tension:
//
//   - Two occurrences of ONE bug must hash identically — across restarts, machines, working
//     directories, OS path separators, and dependency bumps.
//   - Two DIFFERENT bugs must not collide.
//
// The hash covers the error type plus normalized stack frames, and deliberately NOT the message.
// Messages carry the variable part of a failure — ids, paths, counts, timestamps — so hashing them
// splits one bug across dozens of fingerprints, which is the failure mode that makes a reporter
// useless. The message travels on the record for humans to read; it just doesn't group.
import { createHash } from "node:crypto";

/** Frames from these are noise: they say how V8 got there, not what broke. */
const isNodeInternal = (path: string): boolean =>
  path.startsWith("node:") || path.startsWith("internal/");

const isDependency = (path: string): boolean => path.includes("/node_modules/");

/**
 * A stack location reduced to something that survives a move to another machine.
 *
 * Line and column are dropped on purpose. Keeping them would mean any edit above the throw site —
 * a comment, an import — reshuffles the fingerprint and re-reports every known bug as new. Function
 * plus file is coarser but survives ordinary editing, which is the property that matters.
 */
export function normalizeFramePath(raw: string): string {
  let path = raw.trim();
  // ESM stacks give file:// URLs; Windows gives backslashes and a drive letter.
  path = path.replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
  path = path.replace(/^[A-Za-z]:\//, "/");
  // Drop :line:col (or :line). Anchored to the end so a colon inside a path survives.
  path = path.replace(/:\d+(?::\d+)?$/, "");

  if (isNodeInternal(path)) return path;

  // pnpm buries the version in the path — `.pnpm/vitest@2.1.9_hash/node_modules/vitest/x.js`.
  // Left alone, every dependency bump would look like a brand new bug.
  path = path.replace(
    /\/node_modules\/\.pnpm\/[^/]+\/node_modules\//,
    "/node_modules/",
  );
  const dep = path.lastIndexOf("/node_modules/");
  if (dep !== -1) return path.slice(dep + 1);

  // Repo-relative, so an absolute checkout path doesn't leak into the hash.
  const pkg = path.indexOf("/packages/");
  if (pkg !== -1) return path.slice(pkg + 1);

  return path.split("/").pop() ?? path;
}

export interface StackFrame {
  /** Normalized file path — repo-relative, dependency-relative, or a bare basename. */
  path: string;
  /** Function name, or "<anonymous>" for a top-level or arrow frame V8 didn't name. */
  fn: string;
}

// `at fn (loc)` or the bare `at loc` form V8 emits for top-level frames.
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?([^()]+?)\)?\s*$/;

/** Parse a V8 stack into normalized frames, in order, internals dropped. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue; // the `Error: message` header, and anything unrecognized
    const path = normalizeFramePath(m[2] ?? "");
    if (!path || isNodeInternal(path)) continue;
    // `async `/`new ` are call-shape, not identity — the same function under either spelling is
    // the same frame.
    const fn = (m[1] ?? "<anonymous>").replace(/^(?:async|new)\s+/, "");
    frames.push({ path, fn });
  }
  return frames;
}

/**
 * Strip the parts of a message that vary between occurrences of one bug. Only used when there is
 * no usable stack — otherwise every stackless throw in the process would share one fingerprint.
 */
export function scrubMessage(message: string): string {
  return (
    message
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<uuid>",
      )
      // Paths before ids, or the id rule would chew through the segments of a path.
      .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]{2,}/g, "<path>")
      // Any alphanumeric token carrying a digit: curator ids (`4f2a9c1b`), content hashes,
      // durations (`87ms`), ports. Length ≥3 and a digit required, so ordinary words survive.
      // A digit is the tell — it's what distinguishes `4f2a` from `album`. The limitation is
      // digitless hex like `deadbeef`, which is indistinguishable from a word and is left alone.
      .replace(/\b(?=[a-z0-9]*\d)[a-z0-9]{3,}\b/gi, "<id>")
      .replace(/\d+/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** How many frames identify a bug. Deep enough to separate shared helpers, shallow enough that a
 * change further up the call stack doesn't re-key an unchanged bug. */
const FRAME_DEPTH = 5;

export interface FingerprintInput {
  name: string;
  message: string;
  stack?: string;
}

/** Coerce anything `catch` can hand you — Error, string, or some thrown object. */
export function toFingerprintInput(value: unknown): FingerprintInput {
  if (value instanceof Error) {
    return {
      name: value.name || value.constructor?.name || "Error",
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "string") return { name: "thrown", message: value };
  return { name: "thrown", message: safeStringify(value) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // circular, or a throwing toJSON
  }
}

/**
 * A short, stable id for "this bug". Same bug ⇒ same string; different bugs ⇒ different strings.
 *
 * Application frames are preferred over dependency frames: a failure inside `fastify` raised from
 * our code is our bug, and keying it on the library's internals would merge unrelated call sites.
 * Dependency frames are used only when there are no application frames at all.
 */
export function fingerprint(value: unknown): string {
  const { name, message, stack } = toFingerprintInput(value);
  const frames = stack ? parseStack(stack) : [];
  const app = frames.filter((f) => !isDependency(f.path));
  const chosen = (app.length > 0 ? app : frames).slice(0, FRAME_DEPTH);

  // No frames at all (a thrown string, a stripped stack) — fall back to the scrubbed message, or
  // every stackless failure in the process collapses into one fingerprint.
  const body =
    chosen.length > 0
      ? chosen.map((f) => `${f.fn}@${f.path}`).join("|")
      : `msg:${scrubMessage(message)}`;

  return createHash("sha256")
    .update(`${name}\n${body}`)
    .digest("hex")
    .slice(0, 12);
}
