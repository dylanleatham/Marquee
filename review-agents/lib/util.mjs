// Small dependency-free helpers: glob matching + repo file walking + truncation.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  "coverage",
  ".venv",
  "__pycache__",
]);

/** Convert a glob (supports ** and *) to an anchored RegExp against POSIX paths. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/]*";
      }
    } else if ("+?.()|[]{}^$\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const toPosix = (p) => p.split(sep).join("/");

export function matchesAny(file, patterns = []) {
  const f = toPosix(file);
  return patterns.some((p) => globToRegExp(p).test(f));
}

/** Walk the repo from `root`, returning POSIX-relative paths of files matching `patterns`. */
export function filesMatching(root, patterns = []) {
  if (!patterns.length) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (IGNORE.has(entry)) continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else {
        const rel = toPosix(relative(root, abs));
        if (matchesAny(rel, patterns)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Map over `items` with at most `limit` callbacks in flight, preserving input order in the result.
 *
 * `Promise.all(items.map(fn))` starts everything at once; this is the bounded version. The cap is
 * the point — each in-flight item here is a full Claude Code session, and the original sequential
 * design was chosen to be "gentler on a loaded machine than N concurrent sessions". A pool keeps
 * that while removing the part nobody wanted, which was waiting for eight of them end to end.
 *
 * A rejection propagates, as with `Promise.all`; callers that must not lose the other results catch
 * per item inside `fn`.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export function readTruncated(absPath, maxBytes = 16_000) {
  try {
    const s = readFileSync(absPath, "utf8");
    return s.length > maxBytes
      ? s.slice(0, maxBytes) + "\n… (file truncated)"
      : s;
  } catch {
    return null;
  }
}
