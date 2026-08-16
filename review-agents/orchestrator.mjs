#!/usr/bin/env node
// Review-agent orchestrator. See review-agents/README.md and docs/specs/dev-harness.md §6.
//
// Three reviewers, one run each, concurrently: 1-5 minutes. Everything it knows is on stdout;
// there is nothing to triage afterwards and no state it keeps between runs.
//
// Usage:
//   node review-agents/orchestrator.mjs [options]
//     --ci             CI mode: exit 1 on any blocking finding
//     --staged         review staged changes (default: this branch vs origin/main)
//     --base <ref>     diff against an explicit base
//     --reviewer <id>  run a single reviewer
//     --explain        print the context sent to each reviewer
//   Env: REVIEW_MOCK=1 (skip real Claude calls), CLAUDE_CODE_PATH (binary override),
//        REVIEW_TIMEOUT_MS (per-reviewer spawn budget in ms, default 90000),
//        REVIEW_TIMEOUT_RETRIES (extra attempts on a timeout, default 1),
//        REVIEW_CONCURRENCY (sessions in flight at once, default 3)

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  currentSha,
  resolveBase,
  changedFiles,
  unifiedDiff,
} from "./lib/git.mjs";
import {
  claudeAvailable,
  runSpecialist,
  resolveRepairTimeoutMs,
  resolveConcurrency,
  isMock,
} from "./lib/claude.mjs";
import { mapWithConcurrency } from "./lib/util.mjs";
import { summarizeRun, silentWarning } from "./lib/outcome.mjs";
import { composePrompt, repairPrompt } from "./lib/prompt.mjs";
import {
  parseWithRepair,
  salvageProse,
  normalizeFindings,
  dedupe,
} from "./lib/findings.mjs";
import {
  loadSpecialists,
  isTriggered,
  buildContext,
  truncatedContext,
} from "./lib/specialists.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPORT_DIR = join(ROOT, ".review-agents");

// --- args ---
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};
const opts = {
  ci: has("--ci"),
  staged: has("--staged"),
  base: val("--base"),
  reviewer: val("--reviewer"),
  explain: has("--explain"),
};

async function main() {
  const base = resolveBase(opts.base);
  const files = changedFiles({ base, staged: opts.staged });
  const sha = currentSha();

  if (!files.length) {
    console.log("review-agents: no changed files to review.");
    return finish([], []);
  }
  if (!claudeAvailable()) {
    console.warn(
      "review-agents: Claude Code not available (set CLAUDE_CODE_PATH or run `claude login`).\n" +
        "Skipping review without blocking. Findings gate only runs when Claude Code is reachable.",
    );
    return finish([], []); // unavailable ≠ invalid (dev-harness §6 failure modes)
  }

  const diff = unifiedDiff({ base, staged: opts.staged });
  let specialists = loadSpecialists();
  if (opts.reviewer)
    specialists = specialists.filter((s) => s.id === opts.reviewer);
  const relevant = specialists.filter((s) => isTriggered(s, files));

  const concurrency = resolveConcurrency();
  console.log(
    `review-agents: ${files.length} file(s) changed; running ${relevant.length}/${specialists.length} reviewer(s)` +
      (isMock() ? " [MOCK]" : "") +
      `\n  base=${base.slice(0, 12)} sha=${sha.slice(0, 12)} concurrency=${concurrency}`,
  );

  const runs = await mapWithConcurrency(
    relevant,
    concurrency,
    async (config) => {
      const started = Date.now();
      const context = buildContext(config, { files, diff });
      const cut = truncatedContext(config.id);
      if (cut.length) {
        // Not a warning about this run so much as about the roster: a reviewer reading a fragment
        // of the spec it checks against is reviewing less than it claims to. curator-spec.md is
        // 230KB against a 16KB cap.
        console.warn(
          `  [CTX  ] ${config.id}: context truncated at 16KB — ${cut.join(", ")}`,
        );
      }
      if (opts.explain) {
        console.log(
          `\n──── context for ${config.id} ────\n${context.slice(0, 4000)}\n────────────────`,
        );
      }
      const res = await runSpecialist({
        prompt: composePrompt(config, context),
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
      const durationMs = Date.now() - started;
      if (!res.ok) {
        console.warn(`  ! ${config.id}: unavailable (${res.reason})`);
        return {
          id: config.id,
          blocking: !!config.blocking,
          status: "unavailable",
          reason: res.reason,
          durationMs,
          findings: [],
        };
      }
      // One translation round before falling back to prose (issue #117). A repair carries no diff,
      // so it is cheap; it re-uses the reviewer's own model so the wording stays theirs.
      const { raw, outcome } = await parseWithRepair(res.text, {
        repair: (text) =>
          runSpecialist({
            prompt: repairPrompt(text),
            model: config.model,
            timeoutMs: resolveRepairTimeoutMs(),
          }),
      });
      if (outcome === "repaired")
        console.warn(
          `  ~ ${config.id}: reply wasn't JSON — recovered its findings on a reformat pass`,
        );
      if (raw === null) {
        // Persist the unparseable output so the failure is diagnosable (and a regression
        // test can be written) instead of silently lost. See review-agents/KNOWN-ISSUES.md.
        const rawPath = join(
          REPORT_DIR,
          `raw-${config.id}-${sha.slice(0, 12)}.txt`,
        );
        mkdirSync(dirname(rawPath), { recursive: true });
        writeFileSync(rawPath, res.text ?? "");
        // RA-1: a reviewer that spoke in prose still found something worth saying. Surface it
        // as an info finding rather than dropping the review; only a truly empty reply is "error".
        const salvaged = salvageProse(res.text);
        if (salvaged) {
          const findings = normalizeFindings(salvaged, {
            specialist: config.id,
            blocking: false, // prose can't be trusted to gate a push — never blocking
          });
          console.warn(
            `  ! ${config.id}: reply wasn't JSON — surfaced its prose as an info finding (raw saved to ${rawPath})`,
          );
          return {
            id: config.id,
            blocking: !!config.blocking,
            status: "unformatted",
            durationMs,
            findings,
          };
        }
        console.warn(
          `  ! ${config.id}: could not parse findings output (raw saved to ${rawPath})`,
        );
        return {
          id: config.id,
          blocking: !!config.blocking,
          status: "error",
          durationMs,
          findings: [],
        };
      }
      const findings = normalizeFindings(raw, {
        specialist: config.id,
        blocking: !!config.blocking,
      });
      console.log(
        `  ✓ ${config.id}: ${findings.length} finding(s) in ${durationMs}ms`,
      );
      return {
        id: config.id,
        blocking: !!config.blocking,
        status: findings.length ? "ran" : "no-findings",
        repaired: outcome === "repaired",
        durationMs,
        findings,
      };
    },
  );

  return finish(runs, dedupe(runs.flatMap((r) => r.findings)));

  function finish(runSummaries, findings) {
    const { blocking, silent, clean } = summarizeRun(runSummaries, findings);
    printFindings(findings, clean);
    // A blocking reviewer that produced no verdict is reported as loudly as a finding: the run
    // covered less than it claims to (issue #116).
    if (silent.length) console.warn(`\n[GAP  ] ${silentWarning(silent)}`);

    // The report exists for one reader: the Stop hook, which compares its mtime against the
    // working tree to know whether the reviewers have seen the current change. Nothing reads it
    // back afterwards, so it stays a plain dump of what was printed.
    const report = {
      sha,
      base,
      createdAt: new Date().toISOString(),
      reviewers: runSummaries.map(({ id, status, durationMs }) => ({
        id,
        status,
        durationMs,
      })),
      findings,
      blocking: blocking.length,
      // Counted separately so "0 blocking" can never be read as "nothing to worry about" on its own.
      silentBlocking: silent.length,
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, `report-${sha.slice(0, 12)}-${Date.now()}.json`),
      JSON.stringify(report, null, 2),
    );

    if (opts.ci && (blocking.length || silent.length)) {
      if (blocking.length)
        console.error(
          `\nreview-agents: ${blocking.length} blocking finding(s).`,
        );
      if (silent.length)
        console.error(
          `\nreview-agents: ${silent.length} blocking reviewer(s) never ran, so this review is incomplete.`,
        );
      process.exit(1);
    }
    console.log(
      `\nreview-agents: done (${findings.length} finding(s), ${blocking.length} blocking` +
        (silent.length ? `, ${silent.length} reviewer(s) did not run` : "") +
        ").",
    );
  }
}

function printFindings(findings, clean = true) {
  if (!findings.length) {
    // Only claim a clean review when every blocking reviewer actually reviewed the diff.
    // Otherwise stay quiet here and let the gap warning speak (issue #116).
    if (clean) console.log("\nNo findings. 🎵");
    return;
  }
  const order = { blocking: 0, info: 1 };
  for (const f of [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity],
  )) {
    const tag = f.severity === "blocking" ? "FIX " : "note";
    console.log(
      `\n[${tag}] ${f.specialist}  ${f.file}${f.line ? `:${f.line}` : ""}`,
    );
    console.log(`        ${f.message}`);
    if (f.suggestion) console.log(`        → ${f.suggestion}`);
  }
}

main().catch((err) => {
  console.error("review-agents: orchestrator error:", err);
  // An orchestrator bug must not silently block pushes; fail open unless it's clearly ours.
  process.exit(opts.ci ? 0 : 1);
});
