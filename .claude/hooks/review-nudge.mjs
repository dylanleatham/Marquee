#!/usr/bin/env node
// Stop hook: notice that source changed and the reviewers never ran.
//
// CLAUDE.md asks for `pnpm run review` in the inner loop, and the reviewers are deliberately not in
// pre-push, so nothing enforces it. This is the nudge — and it is **only** a nudge. It always exits
// 0 and it never blocks. A hook that gates every session is how people learn to work around the
// harness, and this repo already has a `--no-verify` shaped hole waiting for exactly that.
//
// It is also written to fail silent rather than fail loud: a hook that errors on every Stop would be
// worse than no hook, so anything unexpected here just says nothing.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const quiet = () => process.exit(0);

/** Source files whose change would trigger a blocking reviewer, per each specialist's config. */
const REVIEWABLE =
  /^(packages\/.*\/src\/.*|packages\/stylus\/stylus\/.*\.py|packages\/contracts\/.*)$/;

try {
  // stderr ignored throughout: outside a repo git writes "fatal: not a git repository", and a Stop
  // hook printing that on every session end is precisely the kind of noise that gets a hook removed.
  const git = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });

  const root = git(["rev-parse", "--show-toplevel"]).trim();

  // Working-tree changes, staged or not. A committed-and-clean tree has nothing to review.
  const changed = git(["status", "--porcelain"], root)
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p && REVIEWABLE.test(p));

  if (!changed.length) quiet();

  // A report newer than the newest change counts as "reviewed". Older means the reviewers saw a
  // different tree, which is not the same thing.
  const reportDir = join(root, ".review-agents");
  const newestChange = Math.max(
    ...changed.map((p) => {
      try {
        return statSync(join(root, p)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  const newestReport = existsSync(reportDir)
    ? Math.max(
        0,
        ...readdirSync(reportDir)
          .filter((f) => f.startsWith("report-"))
          .map((f) => statSync(join(reportDir, f)).mtimeMs),
      )
    : 0;

  if (newestReport >= newestChange) quiet();

  const shown = changed.slice(0, 3).join(", ");
  const more = changed.length > 3 ? ` (+${changed.length - 3} more)` : "";
  console.error(
    `\n[review] ${changed.length} reviewable file(s) changed since the last review run: ${shown}${more}\n` +
      `[review] \`pnpm run review\` — three reviewers, a few minutes.\n` +
      `[review] Not a gate — nothing here is blocking your commit.`,
  );
} catch {
  // Not a git repo, git unavailable, anything at all — say nothing.
}
process.exit(0);
