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
