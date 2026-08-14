#!/usr/bin/env node
// Score every specialist against the frozen case set. See review-agents/eval/README.md and
// docs/specs/harness-self-improvement.md §4.2.
//
// Usage:
//   node review-agents/eval/run.mjs                  # score every case against the baseline
//     --repeat <n>        executions per case (default 3; a single run is not a measurement)
//     --case <id>         one case
//     --reviewer <id>     only cases targeting one specialist
//     --write-baseline    record this run as the new baseline
//     --no-cache          ignore cached results
//     --show              print what each specialist actually said
//     --json              machine-readable output
//   Env: REVIEW_MOCK=1 / REVIEW_MOCK_OUTPUT to exercise the pipeline without tokens.
//
// This runs **locally**, never in CI. A GitHub runner has no `claude` binary and no auth — that is
// the whole reason dev-harness §6 put review on the developer's machine — so an eval job in a
// workflow would be a check that can never measure anything, which §11 forbids. CI covers the
// scoring logic (lib/eval.test.mjs, in `test:unit`) and nothing more.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadSpecialists,
  isTriggered,
  buildContext,
} from "../lib/specialists.mjs";
import { composePrompt } from "../lib/prompt.mjs";
import { runSpecialist, claudeAvailable, isMock } from "../lib/claude.mjs";
import { parseWithRepair, normalizeFindings } from "../lib/findings.mjs";
import {
  validateCase,
  filesFromPatch,
  scoreCase,
  majorityOutcome,
  cacheKey,
  cachePolicy,
  gatePolicy,
  summarizeEval,
  toBaseline,
  compareBaseline,
  formatEval,
} from "../lib/eval.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");
const BASELINE_PATH = join(HERE, "baseline.json");
const CACHE_DIR = join(HERE, "..", "..", ".review-agents", "eval-cache");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};
const opts = {
  repeat: Math.max(1, Number(val("--repeat") ?? 3) || 3),
  case: val("--case"),
  reviewer: val("--reviewer"),
  writeBaseline: has("--write-baseline"),
  noCache: has("--no-cache"),
  show: has("--show"),
  json: has("--json"),
};

/** Load every case directory, failing loudly on a malformed one. */
function loadCases() {
  if (!existsSync(CASES_DIR))
    return { cases: [], problems: ["eval/cases/ does not exist"] };
  const cases = [];
  const problems = [];
  for (const id of readdirSync(CASES_DIR).sort()) {
    const dir = join(CASES_DIR, id);
    const defPath = join(dir, "case.json");
    const patchPath = join(dir, "diff.patch");
    if (!existsSync(defPath)) continue;
    let def;
    try {
      def = JSON.parse(readFileSync(defPath, "utf8"));
    } catch (err) {
      problems.push(`${id}: case.json is not valid JSON (${err.message})`);
      continue;
    }
    const issues = validateCase(def, { id });
    if (issues.length) {
      problems.push(...issues);
      continue;
    }
    if (!existsSync(patchPath)) {
      problems.push(`${id}: no diff.patch`);
      continue;
    }
    const patch = readFileSync(patchPath, "utf8");
    const files = filesFromPatch(patch);
    if (!files.length) {
      problems.push(
        `${id}: diff.patch touches no files — it would be reviewed as an empty change`,
      );
      continue;
    }
    cases.push({ ...def, dir, patch, files });
  }
  return { cases, problems };
}

// See cachePolicy in lib/eval.mjs for why a mock run must not touch the cache at all.
const policy = cachePolicy({ mock: isMock(), noCache: opts.noCache });

const readCache = (key) => {
  if (!policy.read) return null;
  const p = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // a corrupt cache entry is a cache miss, never a wrong answer
  }
};

const writeCache = (key, value) => {
  if (!policy.write) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
};

/** Run one specialist over one case's diff, exactly as a real review would. */
async function executeOnce(specialist, testCase) {
  const context = buildContext(specialist, {
    files: testCase.files,
    diff: testCase.patch,
  });
  const res = await runSpecialist({
    prompt: composePrompt(specialist, context),
    model: specialist.model,
    timeoutMs: specialist.timeoutMs,
  });
  if (!res.ok) return { findings: [], failed: res.reason };
  const { raw } = await parseWithRepair(res.text);
  return {
    findings: normalizeFindings(raw ?? [], {
      specialist: specialist.id,
      blocking: !!specialist.blocking,
    }),
    failed: null,
  };
}

async function main() {
  const { cases: allCases, problems } = loadCases();
  if (problems.length) {
    console.error(
      "review-agents eval: malformed case(s) — refusing to score a broken suite:",
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  let cases = allCases;
  if (opts.case) cases = cases.filter((c) => c.id === opts.case);
  if (opts.reviewer)
    cases = cases.filter((c) => c.specialist === opts.reviewer);

  // §11 applied to the eval itself: a suite that scored nothing must not print a clean table. This
  // is the `node --test` hole (#283) in a new place — 0 cases, exit 0, indistinguishable from a pass.
  if (!cases.length) {
    console.error(
      "review-agents eval: 0 cases scored. A suite that measures nothing is a failure, not a pass.\n" +
        (allCases.length
          ? `  ${allCases.length} case(s) exist but the filters selected none.`
          : "  eval/cases/ is empty — see review-agents/eval/README.md."),
    );
    process.exit(1);
  }

  if (!claudeAvailable()) {
    console.error(
      "review-agents eval: Claude Code not available (set CLAUDE_CODE_PATH or run `claude login`).\n" +
        "Unlike a review, an eval that cannot run is a failure — its whole job is to produce a number.",
    );
    process.exit(1);
  }

  const specialists = new Map(loadSpecialists().map((s) => [s.id, s]));
  console.log(
    `review-agents eval: ${cases.length} case(s) × ${opts.repeat} run(s)` +
      (isMock() ? " [MOCK]" : "") +
      `${opts.noCache ? " [no cache]" : ""}`,
  );

  const results = [];
  for (const testCase of cases) {
    const specialist = specialists.get(testCase.specialist);
    const base = {
      id: testCase.id,
      specialist: testCase.specialist,
      kind: testCase.kind,
    };

    if (!specialist) {
      // A case written ahead of its reviewer (the Phase 3 order: cases first, watch them fail).
      results.push({ ...base, outcome: "not-installed", hits: 0, runs: 0 });
      console.log(`  · ${testCase.id}: not-installed (${testCase.specialist})`);
      continue;
    }
    if (!isTriggered(specialist, testCase.files)) {
      // Distinct from a miss on purpose — this is a routing bug, not a prompt one (issue #192).
      results.push({ ...base, outcome: "not-triggered", hits: 0, runs: 0 });
      console.log(
        `  · ${testCase.id}: NOT TRIGGERED — ${testCase.specialist} never sees these files`,
      );
      continue;
    }

    const key = cacheKey({
      caseJson: {
        ...testCase,
        dir: undefined,
        patch: undefined,
        files: undefined,
      },
      patch: testCase.patch,
      specialist,
      repeats: opts.repeat,
    });
    const cached = readCache(key);
    if (cached) {
      results.push({ ...base, ...cached, cached: true });
      console.log(
        `  ✓ ${testCase.id}: ${cached.outcome} (${cached.hits}/${cached.runs}) [cached]`,
      );
      continue;
    }

    const outcomes = [];
    for (let i = 0; i < opts.repeat; i++) {
      const { findings, failed } = await executeOnce(specialist, testCase);
      if (failed) {
        console.warn(`  ! ${testCase.id}: run ${i + 1} failed (${failed})`);
        continue;
      }
      // A miss has two very different causes — the reviewer said nothing useful, or it said the
      // right thing in words the case's patterns don't match. Only the first is a recall gap; the
      // second is a bad `expect`, and shipping a baseline without telling them apart would bake a
      // broken measurement into the gate.
      if (opts.show) {
        console.log(`    ── run ${i + 1}: ${findings.length} finding(s)`);
        for (const f of findings)
          console.log(
            `       [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}\n         ${f.message}`,
          );
      }
      outcomes.push(scoreCase(testCase, findings).outcome);
    }
    if (!outcomes.length) {
      // Every execution failed. Scoring that as a miss would blame the prompt for an outage.
      console.error(`  ! ${testCase.id}: every run failed — not scored`);
      results.push({ ...base, outcome: "error", hits: 0, runs: 0 });
      continue;
    }
    const verdict = majorityOutcome(outcomes);
    writeCache(key, verdict);
    results.push({ ...base, ...verdict });
    console.log(
      `  ✓ ${testCase.id}: ${verdict.outcome} (${verdict.hits}/${verdict.runs})`,
    );
  }

  const errored = results.filter((r) => r.outcome === "error");
  const scored = results.filter((r) => r.outcome !== "error");
  if (!scored.length) {
    console.error(
      "\nreview-agents eval: every case errored. Nothing was measured.",
    );
    process.exit(1);
  }

  const summary = summarizeEval(scored);
  // A filtered run scores a deliberate subset, so the baseline's "this specialist's cases vanished"
  // rule — which exists to catch someone deleting cases to make the gate green — would fire on every
  // `--case` and `--reviewer` invocation. Those are the diagnostic flags, used constantly while
  // tuning an `expect` block, and a gate that cries REGRESSED at every diagnostic teaches you to
  // stop reading it.
  const filtered = Boolean(opts.case || opts.reviewer);
  // A mock run is excluded for the same reason it is excluded from the cache: `REVIEW_MOCK=1`
  // answers `[]` for every specialist, so every must-find case "misses" and the gate reports a
  // total collapse that means nothing. Comparing it would train you to ignore the word REGRESSED.
  const gate = gatePolicy({ mock: isMock(), filtered });
  const baseline =
    gate.compare && existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
      : null;

  if (opts.json) {
    console.log(JSON.stringify({ results, summary, baseline }, null, 2));
  } else {
    console.log("\n" + formatEval(summary, { repeats: opts.repeat, baseline }));
  }
  if (errored.length)
    console.warn(
      `\n[WARN ] ${errored.length} case(s) errored and were left out of the table.`,
    );

  if (opts.writeBaseline && !gate.writeBaseline) {
    // Recording a subset as *the* baseline would quietly delete every unscored specialist's floor —
    // the precise move the anti-deletion rule exists to catch, performed by the tool itself. A mock
    // baseline is worse: every figure in it would be zero, so the gate would pass forever after.
    // This is not hypothetical — a REVIEW_MOCK run wrote exactly that file before this guard landed.
    console.error(
      isMock()
        ? "\nreview-agents eval: refusing to write a baseline from a mock run.\n" +
            "REVIEW_MOCK answers [] for every specialist, so the recorded floor would be all zeroes."
        : "\nreview-agents eval: refusing to write a baseline from a filtered run.\n" +
            "--case/--reviewer score a subset, and the result would silently drop every specialist they excluded.",
    );
    process.exit(1);
  }
  if (opts.writeBaseline) {
    const next = toBaseline(summary, {
      repeats: opts.repeat,
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log(
      `\nBaseline written to review-agents/eval/baseline.json — commit it.`,
    );
    return;
  }

  if (!gate.compare) {
    console.log(
      isMock()
        ? "\nreview-agents eval: mock run — no real verdicts, so the baseline was not compared."
        : "\nreview-agents eval: filtered run — scored a subset, so the baseline was not compared.\n" +
            "Run without --case/--reviewer to gate.",
    );
    return;
  }
  if (!baseline) {
    console.error(
      "\nreview-agents eval: no baseline recorded, so there is nothing to compare against.\n" +
        "Record one with `--write-baseline` once you are happy the numbers are real.",
    );
    process.exit(1);
  }
  const cmp = compareBaseline(summary, baseline);
  if (!cmp.ok) {
    console.error(
      "\nreview-agents eval: this harness edit regressed the case set. Fix it, or record a new " +
        "baseline deliberately with --write-baseline and say why in the PR.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("review-agents eval: runner error:", err);
  process.exit(1);
});
