#!/usr/bin/env node
// Turn an escaped bug into an eval case, using the commit that fixed it.
//
// The case set seeds itself from this repo's own history. Every `fix(...)` commit on `main` is a
// bug that got past the reviewers, so its **reverse diff** is a change that reintroduces it — and a
// reviewer worth keeping should flag that. `git show -R <sha>` is therefore the case's diff.patch.
//
// Two things to know about that trick, both of which need a human afterwards:
//
//  1. **Exclude the tests the fix added.** A reverse diff deletes them, and a diff that deletes a
//     test called `does not wedge when the reader is slow` hands the reviewer the answer. The case
//     then measures whether the model can read a test name, not whether it can spot the bug.
//     `--exclude` is for this, and it is the usual reason a seeded case is wrong.
//  2. **Not every reversed fix is a plausible change.** Some read as obvious vandalism, which makes
//     an easy case that proves little. Read the patch before keeping the case.
//
// The `expect` block is deliberately left as a TODO for a person to write. Generating it from the
// commit message would mean the case set was authored by the same kind of model it scores — the
// independent-rater problem in docs/specs/harness-self-improvement.md §2.
//
// Usage:
//   node review-agents/eval/seed-from-history.mjs <sha> --specialist runtime [options]
//     --specialist <id>   which reviewer should have caught it (required)
//     --kind <k>          must-find (default) | must-not-find
//     --forward           use the commit as-is instead of reversing it (see below)
//     --exclude <glob>    drop matching paths from the diff; repeatable
//     --id <slug>         case directory name (default: <shortsha>-<subject slug>)
//
// `--forward` exists because reversal is the wrong shape for two kinds of case:
//
//   * **test-auditor.** Its job is "new surface arrived without a test". The way to build that is a
//     real feature commit with its test files excluded — forward, not reversed. Reversing would
//     produce code being *deleted*, which is not the situation the rule is about.
//   * **must-not-find.** A clean merged feature is already the case; reversing it would produce a
//     revert, which is a different change with different risks.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchesAny } from "../lib/util.mjs";
import { filesFromPatch } from "../lib/eval.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};
const all = (f) =>
  argv.reduce(
    (acc, a, i) => (a === f && argv[i + 1] ? [...acc, argv[i + 1]] : acc),
    [],
  );

const sha = positional[0];
const specialist = val("--specialist");
const kind = val("--kind") ?? "must-find";
const excludes = all("--exclude");

if (!sha || !specialist) {
  console.error(
    "usage: seed-from-history.mjs <sha> --specialist <id> [--kind must-find|must-not-find]\n" +
      "                             [--exclude <glob>]… [--id <slug>]",
  );
  process.exit(1);
}

const git = (args) =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const subject = git(["log", "-1", "--format=%s", sha]).trim();
const shortSha = git(["rev-parse", "--short", sha]).trim();

const forward = argv.includes("--forward");
/** The fix reversed — the change that puts the bug back — unless asked for the commit as-is. */
const full = git(["show", ...(forward ? [] : ["-R"]), "--format=", sha]);

/**
 * Drop excluded paths, file section by file section. Splitting on `diff --git` keeps each file's
 * hunks together, so an exclusion removes a whole file rather than leaving orphaned hunks that no
 * longer apply.
 */
function filterPatch(patch, globs) {
  if (!globs.length) return patch;
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  return sections
    .filter((section) => {
      const files = filesFromPatch(section);
      return !files.length || !files.every((f) => matchesAny(f, globs));
    })
    .join("");
}

const patch = filterPatch(full, excludes);
const files = filesFromPatch(patch);
if (!files.length) {
  console.error(
    `seed: after --exclude, the patch touches no files. The case would be an empty change.`,
  );
  process.exit(1);
}

const slug = subject
  .toLowerCase()
  .replace(/^\w+(\([^)]*\))?:\s*/, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 60);
const id = val("--id") ?? `${shortSha}-${slug}`;
const dir = join(HERE, "cases", id);
if (existsSync(dir)) {
  console.error(`seed: ${id} already exists.`);
  process.exit(1);
}

const def = {
  id,
  source: `commit:${shortSha} (reversed)`,
  kind,
  specialist,
  ...(kind === "must-find"
    ? {
        expect: {
          file: files[0],
          matches: ["TODO — a pattern the finding's message must match"],
        },
      }
    : {}),
  notes: `Reverse of "${subject}". TODO: confirm the reversed diff reads as a plausible change, and write the expect block by hand.`,
};

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "case.json"), JSON.stringify(def, null, 2) + "\n");
writeFileSync(join(dir, "diff.patch"), patch);

console.log(`seeded eval/cases/${id}/`);
console.log(`  from   : ${shortSha} ${subject}`);
console.log(`  files  : ${files.join(", ")}`);
console.log(
  `  next   : write the expect block by hand, then \`--case ${id}\` to try it.`,
);
