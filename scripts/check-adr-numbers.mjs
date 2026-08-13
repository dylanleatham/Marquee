#!/usr/bin/env node
// Fail the push if an ADR number stops naming exactly one decision (issues #151, #316, #317).
//
// The checks themselves are older than this file — they lived in `packages/curator/test/
// adr-numbering.test.ts`, which is still where they are *proven* (see the fixture suites there;
// this file is the single implementation both it and the pre-push hook use). They moved here for
// one reason: the test was the only place they ran, and it could not run when it mattered.
//
//   - CI's `test:unit` leg is the only job that runs it, and `CI_ENABLED=false` (the Actions
//     billing block) skips every job in `ci.yml` and `nightly.yml`.
//   - `pre-push` runs `turbo run … --filter="...[HEAD^1]"`. An ADR is a docs-only change touching
//     no package, so the affected-only filter selects *nothing* — zero tests run on the one push
//     that can introduce a collision. `ci.yml` calls out that exact trap in a comment and avoids
//     it deliberately; `pre-push` never got the same treatment.
//
// With both layers silent, three collisions shipped in a row (#151 on 0022/0023, then 0075/0076,
// then 0077/0078 — the last of them *created* by a renumber that was meant to fix the one before).
// A node script with no dependencies runs in ~100ms from a git hook, which is the only place a
// guard for a docs-only change can honestly live in this repo.
//
// Usage:
//   node scripts/check-adr-numbers.mjs              # every check, including against origin/main
//   node scripts/check-adr-numbers.mjs --local      # skip the origin/main check (no network)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GIT_TIMEOUT_MS = 15_000;

/** @typedef {{ file: string, number: string, heading: string | undefined }} Adr */

/** The ADRs in `dir` — numbered filenames only, sorted, each paired with its heading number. */
export function collectAdrs(dir) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((file) => ({
      file,
      number: file.slice(0, 4),
      heading: readFileSync(join(dir, file), "utf8")
        .split("\n")
        .find((l) => l.startsWith("# "))
        ?.match(/^# ADR (\d{4})\b/)?.[1],
    }));
}

/** Numbers claimed by more than one ADR. Empty = each number names exactly one decision. */
export function collisionsIn(adrs) {
  const byNumber = new Map();
  for (const adr of adrs) {
    byNumber.set(adr.number, [...(byNumber.get(adr.number) ?? []), adr.file]);
  }
  // Name both files: the fix is a rename plus a citation sweep, and you need to know which two.
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => `${number}: ${files.join(" and ")}`);
}

/** ADRs whose `# ADR NNNN` heading disagrees with their filename — a half-finished renumber. */
export function headingMismatchesIn(adrs) {
  return adrs
    .filter((a) => a.heading !== a.number)
    .map((a) => `${a.file} → heading says ${a.heading ?? "(none)"}`);
}

/**
 * Numbers that name a different file here than they do on the base branch.
 *
 * This is the check `collisionsIn` cannot make, and the one #316 needed. A branch that renumbers
 * an ADR into 0077 sees no collision *in its own tree* — main's 0077 isn't there, because the
 * branch hasn't merged main. That is exactly the position commit `6f85a8e` was in when it moved
 * the curator/amp pair off 0075/0076 and onto two numbers Stylus had just taken: locally clean,
 * broken the moment it landed. Comparing against what `origin/main` has already published is the
 * only way to see it before the merge.
 *
 * A number missing from `baseFiles` is fine — that's a genuinely new ADR. A number *present* in
 * both must name the same file, and that is stricter than it may look on purpose: ADRs are
 * "numbered, immutable, citable" (CLAUDE.md), so re-slugging or deleting one that main has already
 * published breaks every citation that isn't in this repo — PR bodies, issue comments, review
 * threads — which no sweep can reach. Supersede it with a new ADR instead.
 *
 * The exception is a number that is *already* colliding on the base. There is no mapping to
 * preserve — main never allocated it to one decision — and the only way out is to move one of the
 * two, which is precisely the branch this check would otherwise block. `collisionsIn` still has to
 * pass on the result, so the escape hatch can't be used to leave the tree broken.
 *
 * @param {Adr[]} local ADRs in the working tree.
 * @param {string[]} baseFiles ADR filenames allocated on the base branch (bare names, no path).
 */
export function driftFromBaseIn(local, baseFiles) {
  const here = new Map(local.map((a) => [a.number, a.file]));
  const timesUsedOnBase = new Map();
  for (const f of baseFiles) {
    const n = f.slice(0, 4);
    timesUsedOnBase.set(n, (timesUsedOnBase.get(n) ?? 0) + 1);
  }
  const drift = [];
  for (const baseFile of [...baseFiles].sort()) {
    const number = baseFile.slice(0, 4);
    if (timesUsedOnBase.get(number) > 1) continue;
    const mine = here.get(number);
    if (mine === baseFile) continue;
    drift.push(
      `${number}: origin/main has ${baseFile}, this tree has ${mine ?? "(nothing)"}`,
    );
  }
  return drift;
}

/** The lowest number no ADR uses, here or on the base — what a renumber should actually take. */
export function nextFreeNumber(local, baseFiles) {
  const used = [
    ...local.map((a) => a.number),
    ...baseFiles.map((f) => f.slice(0, 4)),
  ].map(Number);
  return String(Math.max(0, ...used) + 1).padStart(4, "0");
}

/** ADR links in `files` whose target doesn't exist, relative to the linking file. */
export function brokenAdrLinksIn(files, root) {
  const broken = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, href] of text.matchAll(
      /\]\(([^)]*adrs\/\d{4}-[^)]+\.md)\)/g,
    )) {
      if (!existsSync(join(dirname(file), href))) {
        broken.push(`${file.slice(root.length + 1)} → ${href}`);
      }
    }
  }
  return broken;
}

/**
 * ADR links in `files` whose label names a different ADR than the file it points at.
 *
 * The other half of the citability problem, and the one a resolving link hides: issue #233 found
 * thirteen Discogs comments citing "ADR 0016" (Stylus) when they meant 0017 — both accepted the same
 * day. Converting those to links is what puts them under `brokenAdrLinksIn`, but a link is only as
 * honest as its label: `[ADR 0016](…/0017-*.md)` resolves perfectly and still tells the reader the
 * wrong thing. A bare number can't be checked at all; a link can, so check it.
 */
export function labelHrefMismatchesIn(files, root) {
  const mismatched = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, label, href] of text.matchAll(
      /\[ADR (\d{4})\]\(([^)]*adrs\/(\d{4})-[^)]+\.md)\)/g,
    )) {
      const target = href.match(/adrs\/(\d{4})-/)?.[1];
      if (label !== target) {
        mismatched.push(
          `${file.slice(root.length + 1)} → [ADR ${label}](${href})`,
        );
      }
    }
  }
  return mismatched;
}

/** Files whose bytes aren't worth scanning for a markdown link. Everything else is. */
const BINARY =
  /\.(jpe?g|png|gif|ico|webp|svgz|pdf|zip|gz|woff2?|ttf|otf|eot|mp[34]|wav|bin)$/i;
const MAX_BYTES = 2 * 1024 * 1024; // a 9MB logo has no ADR citations in it

/**
 * Every tracked file that could cite an ADR — which is *every* tracked text file, deliberately.
 *
 * This used to be three globs: `docs` markdown, `packages` TS/TSX, and `CLAUDE.md`. Eighteen files
 * cited ADRs from outside that set — `.py`, `.toml`, `.css`, `.js`, `.mjs`, and every README and
 * DEPLOY guide under `packages/` — and none of them were checked. The #316 renumber broke
 * `packages/stylus/stylus/dispatch.py` and the guard said nothing, because the hand sweep had been
 * written to match the same three globs. A gate that defines its own scope narrowly teaches the
 * sweep to be narrow too.
 *
 * `git ls-files` rather than a directory walk: it is the definition of "in the repo", it inherits
 * `.gitignore` for free (no `node_modules`, no `dist`, no `.turbo`), and an untracked scratch file
 * can't fail someone else's push. A **denylist** of binary extensions rather than an allowlist of
 * text ones, so the next file type to cite an ADR is covered without anyone remembering to add it.
 */
export function citingSources(repoRoot) {
  return git(["ls-files", "-z"], repoRoot)
    .split("\0")
    .filter((p) => p && !BINARY.test(p))
    .map((p) => join(repoRoot, p))
    .filter((p) => {
      // Tracked-but-deleted (mid-rename) would otherwise throw in the readers above.
      try {
        return statSync(p).size <= MAX_BYTES;
      } catch {
        return false;
      }
    });
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    // Matches scripts/check-conflict-markers.mjs. `git ls-files -z` over the whole tree is ~30KB
    // today, but Node's default is 1MB and a repo only grows.
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Bare ADR filenames out of `git ls-tree -z --name-only <ref> docs/adrs/`.
 *
 * Split out so it can be tested without a git repo: NUL-separated, path-prefixed, and with a
 * trailing separator git always emits. Anything that isn't a numbered ADR is dropped, which also
 * disposes of the quoted form git falls back to for exotic filenames.
 */
export function adrFilesFromLsTree(output) {
  return output
    .split("\0")
    .map((p) => p.trim().replace(/^docs\/adrs\//, ""))
    .filter((f) => /^\d{4}-.*\.md$/.test(f));
}

/**
 * ADR filenames allocated on `ref`, fetching it first so a stale ref can't pass a branch that has
 * been open while main moved — the window #316 landed in.
 *
 * Throws rather than returning `[]` if the ref can't be resolved. A gate that quietly downgrades to
 * "nothing to compare against" is the failure mode this repo keeps having; `--local` is the way to
 * say you meant it.
 *
 * `ref` is a parameter so the tests can point it at a local branch in a throwaway repo; only a
 * remote-tracking ref is worth a fetch.
 */
export function baseAdrFiles(repoRoot, ref = "origin/main") {
  if (ref.startsWith("origin/")) {
    try {
      git(
        ["fetch", "--quiet", "origin", ref.slice("origin/".length)],
        repoRoot,
      );
    } catch {
      // Offline, or no `origin`. The ref may still resolve from the last fetch — try it, and let
      // the rev-parse below be what fails if it doesn't.
    }
  }
  git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
  return adrFilesFromLsTree(
    git(["ls-tree", "-z", "--name-only", ref, "docs/adrs/"], repoRoot),
  );
}

function main(argv) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const adrDir = join(repoRoot, "docs", "adrs");
  const local = collectAdrs(adrDir);
  const sources = citingSources(repoRoot);

  const failures = [
    ["Numbers naming more than one decision", collisionsIn(local)],
    [
      "ADRs whose heading disagrees with their filename",
      headingMismatchesIn(local),
    ],
    ["ADR links that don't resolve", brokenAdrLinksIn(sources, repoRoot)],
    [
      "ADR links whose label names a different ADR",
      labelHrefMismatchesIn(sources, repoRoot),
    ],
  ];

  let baseFiles = [];
  if (argv.includes("--local")) {
    console.log(
      "check-adr-numbers: --local, skipping the origin/main comparison.",
    );
  } else {
    try {
      baseFiles = baseAdrFiles(repoRoot);
      failures.push([
        "Numbers that name a different decision than they do on origin/main",
        driftFromBaseIn(local, baseFiles),
      ]);
    } catch (err) {
      console.error(
        "check-adr-numbers: could not resolve origin/main, so the check that catches a renumber\n" +
          "landing on someone else's ADR did not run. Fetch and retry, or pass --local if you\n" +
          `meant to skip it.\n  ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  const found = failures.filter(([, items]) => items.length > 0);
  if (found.length === 0) return 0;

  for (const [title, items] of found) {
    console.error(`\n${title}:`);
    for (const item of items) console.error(`  ${item}`);
  }
  console.error(
    `\nAn ADR number must name exactly one decision, here and on origin/main (issue #151).` +
      `\nThe next free number is ${nextFreeNumber(local, baseFiles)}.` +
      `\nRenumbering is a rename plus a sweep of every citation in every tracked file — not just` +
      `\nthe docs: the last one broke a .py docstring. Both the link label and the href.\n`,
  );
  return 1;
}

// CLI. `import.meta.main` is not available on Node 22, so compare argv instead — same shape as
// scripts/check-conflict-markers.mjs and scripts/idle-audit.mjs, whose form dodges the Windows
// path-separator mismatch. A test that imports this file must not trigger the run.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  process.exit(main(process.argv.slice(2)));
}
