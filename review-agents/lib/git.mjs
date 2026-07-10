// Git helpers for the review orchestrator.
import { spawnSync } from "node:child_process";

const git = (args) => {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

const gitQuiet = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function currentSha() {
  return git(["rev-parse", "HEAD"]);
}

/**
 * Resolve the base commit to diff against.
 * Priority: explicit --base > merge-base with origin/main > merge-base with main > HEAD^ > empty tree.
 */
export function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const ref of ["origin/main", "main"]) {
    const mb = gitQuiet(["merge-base", ref, "HEAD"]);
    if (mb) return mb;
  }
  const parent = gitQuiet(["rev-parse", "--verify", "-q", "HEAD^"]);
  if (parent) return parent;
  // No parent (first commit): diff against the empty tree.
  return git(["hash-object", "-t", "tree", "/dev/null"]);
}

/** Files changed between base and the working tree (or staged, if staged=true). */
export function changedFiles({ base, staged }) {
  const args = staged
    ? ["diff", "--name-only", "--cached", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`];
  const out = git(args);
  return out
    ? out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Unified diff for the changed set, capped to keep prompts sane. */
export function unifiedDiff({ base, staged, maxBytes = 200_000 }) {
  const args = staged ? ["diff", "--cached"] : ["diff", `${base}...HEAD`];
  const out = git(args);
  return out.length > maxBytes
    ? out.slice(0, maxBytes) + "\n… (diff truncated)"
    : out;
}
