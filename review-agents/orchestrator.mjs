#!/usr/bin/env node
// Review-agent orchestrator. See review-agents/README.md and docs/specs/dev-harness.md §6.
//
// Usage:
//   node review-agents/orchestrator.mjs [options]
//     --ci                 CI/hook mode: write report, exit 1 on any blocking finding
//     --staged             review staged changes (default: this branch vs origin/main)
//     --base <ref>         diff against an explicit base
//     --reviewer <id>      run a single specialist
//     --explain            print the context sent to each specialist
//     --fast               only the blocking specialists — the mid-session check
//     --triage             judge the last report's findings into review-agents/ledger.jsonl
//     --stats              print per-specialist volume + precision from the ledger
//   Env: REVIEW_MOCK=1 (skip real Claude calls), CLAUDE_CODE_PATH (binary override),
//        REVIEW_TIMEOUT_MS (per-specialist spawn budget in ms, default 90000),
//        REVIEW_TIMEOUT_RETRIES (extra attempts on a timeout, default 1),
//        REVIEW_CONCURRENCY (sessions in flight at once, default 3)

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
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
import {
  loadLedger,
  appendRecords,
  computeStats,
  formatStats,
} from "./lib/ledger.mjs";
import { resolveReport, runTriage } from "./lib/triage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

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
  fast: has("--fast"),
  triage: has("--triage"),
  stats: has("--stats"),
};

const REPORT_DIR = join(ROOT, ".review-agents");
const LEDGER_PATH = join(HERE, "ledger.jsonl");

/** `--stats`: what the ledger knows. Read-only; never runs a specialist. */
function printStats() {
  const { records, skipped } = loadLedger(LEDGER_PATH);
  console.log(formatStats(computeStats(records), { skipped }));
}

/** `--triage`: judge the last report's findings and append the verdicts to the ledger. */
async function triage() {
  const resolved = resolveReport(REPORT_DIR, currentSha());
  if (!resolved) {
    console.error(
      "review-agents: no report to triage. Run `pnpm run review` first.",
    );
    process.exit(1);
  }
  if (!resolved.forCurrentSha) {
    console.log(
      `review-agents: no report for the current commit — triaging the most recent one instead\n` +
        `  ${resolved.path} (sha ${String(resolved.report.sha).slice(0, 12)})`,
    );
  }
  // Interactive by design, so it must never hang waiting on a stdin nobody is typing into: a
  // --triage that wedges a hook or a CI job would be a far worse harness bug than an unmeasured
  // reviewer.
  if (!process.stdin.isTTY) {
    console.error(
      "review-agents: --triage is interactive and stdin is not a terminal.\n" +
        "Run it from a shell, not from a hook, a pipe, or CI.",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { records } = loadLedger(LEDGER_PATH);
    const result = await runTriage({
      report: resolved.report,
      records,
      ask: (q) => rl.question(q),
      append: (recs) => appendRecords(LEDGER_PATH, recs),
    });
    if (result.judged || result.skipped) {
      console.log(
        `\nreview-agents: ${result.judged} judged, ${result.skipped} skipped` +
          (result.quit ? " (stopped early)" : "") +
          `. Ledger: review-agents/ledger.jsonl — commit it.\n` +
          `Run \`pnpm run review:stats\` to see what it adds up to.`,
      );
    }
  } finally {
    rl.close();
  }
}

async function main() {
  // Both verbs read what past runs recorded; neither spends a token or needs a diff.
  if (opts.stats) return printStats();
  if (opts.triage) return triage();

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

  let relevant = specialists.filter((s) => isTriggered(s, files));
  // --fast: the mid-session check. Only the reviewers that can actually stop a push, so the loop is
  // short enough to run while the change is still in your head — which is what CLAUDE.md asks for
  // and what the full roster's wall clock made unrealistic. The full set still runs before the PR.
  const skippedByFast = opts.fast ? relevant.filter((s) => !s.blocking) : [];
  if (opts.fast) relevant = relevant.filter((s) => s.blocking);

  const concurrency = resolveConcurrency();
  console.log(
    `review-agents: ${files.length} file(s) changed; running ${relevant.length}/${specialists.length} specialist(s)` +
      (isMock() ? " [MOCK]" : "") +
      (opts.fast ? " [FAST]" : "") +
      `\n  base=${base.slice(0, 12)} sha=${sha.slice(0, 12)} concurrency=${concurrency}`,
  );
  if (skippedByFast.length)
    console.log(
      `  --fast skipped ${skippedByFast.length} informational specialist(s): ` +
        `${skippedByFast.map((s) => s.id).join(", ")}. Run without --fast before the PR.`,
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
      // so it is cheap; it re-uses the specialist's own model so the wording stays theirs.
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
          ROOT,
          ".review-agents",
          `raw-${config.id}-${sha.slice(0, 12)}.txt`,
        );
        mkdirSync(dirname(rawPath), { recursive: true });
        writeFileSync(rawPath, res.text ?? "");
        // RA-1: a specialist that spoke in prose still found something worth saying. Surface it
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

  const all = dedupe(runs.flatMap((r) => r.findings));
  return finish(runs, all);

  function finish(runSummaries, findings) {
    const { blocking, silent, clean } = summarizeRun(runSummaries, findings);
    printFindings(findings, clean);
    // A blocking specialist that produced no verdict is reported as loudly as a finding: the run
    // covered less than it claims to (issue #116).
    if (silent.length) console.warn(`\n[GAP  ] ${silentWarning(silent)}`);

    const report = {
      sha,
      base,
      createdAt: new Date().toISOString(),
      specialists: runSummaries.map(
        ({ id, status, durationMs, blocking: isBlocking }) => ({
          id,
          status,
          durationMs,
          blocking: !!isBlocking,
        }),
      ),
      findings,
      blocking: blocking.length,
      // Counted separately so "0 blocking" can never be read as "nothing to worry about" on its own.
      silentBlocking: silent.length,
      // The prose-reply rate (RA-4 / issue #117), so the fix there is measurable rather than assumed.
      unformatted: runSummaries.filter((r) => r.status === "unformatted")
        .length,
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, `report-${sha}.json`),
      JSON.stringify(report, null, 2),
    );

    if (opts.ci && (blocking.length || silent.length)) {
      if (blocking.length)
        console.error(
          `\nreview-agents: ${blocking.length} blocking finding(s). Push blocked.`,
        );
      if (silent.length)
        console.error(
          `\nreview-agents: ${silent.length} blocking specialist(s) never ran, so this review is incomplete. Push blocked.`,
        );
      console.error(
        "Address them, or bypass in a genuine emergency with `git push --no-verify`.",
      );
      process.exit(1);
    }
    console.log(
      `\nreview-agents: done (${findings.length} finding(s), ${blocking.length} blocking` +
        (silent.length ? `, ${silent.length} specialist(s) did not run` : "") +
        ").",
    );
    // The verdict is only cheap while the diff is still in your head, so ask for it now rather
    // than hoping the verb is remembered later. This is the whole input to dev-harness §12's
    // "track the ratio" — untriaged, the run leaves no trace once the report is discarded.
    if (findings.length && !opts.ci) {
      console.log(
        "Judge these into the ledger while they're fresh: `pnpm run review --triage`",
      );
    }
  }
}

function printFindings(findings, clean = true) {
  if (!findings.length) {
    // Only claim a clean review when every blocking specialist actually reviewed the diff.
    // Otherwise stay quiet here and let the gap warning speak (issue #116).
    if (clean) console.log("\nNo findings. 🎵");
    return;
  }
  const order = { blocking: 0, info: 1 };
  for (const f of [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity],
  )) {
    const tag = f.severity === "blocking" ? "BLOCK" : "info ";
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
