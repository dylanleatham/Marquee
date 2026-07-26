#!/usr/bin/env node
// Fail the commit if a conflict marker survived a merge resolution (issue #113).
//
// `prettier --check` does not catch these: to a markdown parser `<<<<<<< HEAD` is ordinary text,
// and prettier will happily *reformat* the closing marker into a nested blockquote
// (`>>>>>>> abc123` → `> > > > > > > abc123`), which then looks intentional in the rendered doc.
// That is exactly how #113 shipped both sides of a conflict into curator-spec.md's Settings section
// and nothing complained.
//
// Usage:
//   node scripts/check-conflict-markers.mjs            # every tracked file
//   node scripts/check-conflict-markers.mjs --staged   # staged adds/copies/modifies only
//
// The pre-commit hook runs the --staged form *before* lint-staged, so markers are seen in their
// raw shape rather than after prettier has disguised them.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Assembled at runtime so this file — and the test that imports it — never trips its own scan. */
const OPEN = "<".repeat(7);
const BASE = "|".repeat(7);
const MID = "=".repeat(7);
const CLOSE = ">".repeat(7);

/** Markers that are never legitimate at the start of a line, in any language we write. */
const UNAMBIGUOUS = [OPEN, BASE, CLOSE];

/**
 * Prettier rewrites a closing marker in markdown into a seven-deep blockquote. Nothing legitimate
 * nests blockquotes seven levels, so this stays a reliable signal after the file has been formatted.
 */
const MANGLED_CLOSE = /^(?:>[ \t]*){7}/;

const MAX_BYTES = 2 * 1024 * 1024; // a marker in a file this large is not the case we're guarding
const GIT_TIMEOUT_MS = 15_000;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Tracked files, or just the staged ones. Deletions are excluded — there is nothing to read. */
export function filesToScan(cwd, { staged = false } = {}) {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACM"], cwd)
    : git(["ls-files"], cwd);
  return out.split("\n").filter(Boolean);
}

function readText(abs) {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null; // staged-then-removed, or a broken symlink
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const buf = readFileSync(abs);
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}

/**
 * `=======` is a setext heading underline in markdown and a separator comment in plenty of code, so
 * it only counts when it sits inside an already-open conflict region. The other markers stand alone.
 */
export function scanText(text) {
  const hits = [];
  let open = false;
  text.split("\n").forEach((line, i) => {
    const at = (marker) =>
      hits.push({ line: i + 1, marker, text: line.trim() });
    const found = UNAMBIGUOUS.find(
      (m) =>
        line.startsWith(m) &&
        (line.length === m.length || /\s/.test(line[m.length])),
    );
    if (found) {
      at(found);
      if (found === OPEN) open = true;
      if (found === CLOSE) open = false;
      return;
    }
    if (MANGLED_CLOSE.test(line)) {
      at(CLOSE);
      open = false;
      return;
    }
    if (open && line.trimEnd() === MID) at(MID);
  });
  return hits;
}

/** @returns {{file: string, line: number, marker: string, text: string}[]} */
export function scanForConflictMarkers(cwd, opts) {
  const hits = [];
  for (const file of filesToScan(cwd, opts)) {
    const text = readText(join(cwd, file));
    if (text === null) continue;
    for (const hit of scanText(text)) hits.push({ file, ...hit });
  }
  return hits;
}

// CLI. `import.meta.main` is not available on Node 22, so compare argv instead.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  const staged = process.argv.includes("--staged");
  const hits = scanForConflictMarkers(process.cwd(), { staged });
  if (hits.length) {
    console.error(
      `Conflict markers found in ${new Set(hits.map((h) => h.file)).size} file(s):`,
    );
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    console.error("\nFinish the merge resolution before committing.");
    process.exit(1);
  }
}
