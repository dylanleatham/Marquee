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
//   Env: REVIEW_MOCK=1 (skip real Claude calls), CLAUDE_CODE_PATH (binary override),
//        REVIEW_TIMEOUT_MS (per-specialist spawn budget in ms, default 90000),
//        REVIEW_TIMEOUT_RETRIES (extra attempts on a timeout, default 1)

import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  currentSha,
  resolveBase,
  changedFiles,
  unifiedDiff,
} from "./lib/git.mjs";
import { claudeAvailable, runSpecialist, isMock } from "./lib/claude.mjs";
import { summarizeRun, silentWarning } from "./lib/outcome.mjs";
import {
  extractJsonArray,
  salvageProse,
  normalizeFindings,
  dedupe,
} from "./lib/findings.mjs";
import { matchesAny, filesMatching, readTruncated } from "./lib/util.mjs";

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
};

// Which specs to hand a specialist when a given package changes (dev-harness §6).
const PACKAGE_SPECS = {
  curator: [
    "curator-spec.md",
    "roadie-spec.md",
    "album-onboarding-workflow.md",
  ],
  "palette-press": ["palette-press-spec.md", "integration-contract.md"],
  "hue-conductor": ["hue-conductor-spec.md", "integration-contract.md"],
  backdrop: ["backdrop-spec.md"],
  stylus: ["stylus-spec.md"],
  contracts: ["integration-contract.md"],
};

function loadSpecialists() {
  const out = [];
  for (const dir of readdirSync(HERE)) {
    const cfgPath = join(HERE, dir, "config.json");
    if (!existsSync(cfgPath)) continue;
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    config.systemPrompt =
      readTruncated(join(HERE, dir, "system-prompt.md"), 40_000) ?? "";
    config.examples =
      readTruncated(join(HERE, dir, "examples.md"), 20_000) ?? "";
    out.push(config);
  }
  return out;
}

function isTriggered(config, files) {
  if (!files.length) return false;
  if (config.triggerAll) return true;
  if (
    config.triggerGlobs &&
    files.some((f) => matchesAny(f, config.triggerGlobs))
  )
    return true;
  if (config.triggerImports?.length) {
    // Only scan real source files — not lockfiles, docs, or generated output.
    const sourceFiles = files.filter((f) =>
      /\.(ts|tsx|mjs|cjs|js|py)$/.test(f),
    );
    for (const f of sourceFiles) {
      const src = readTruncated(join(ROOT, f), 40_000);
      if (src && config.triggerImports.some((imp) => src.includes(imp)))
        return true;
    }
  }
  return false;
}

function changedPackages(files) {
  const pkgs = new Set();
  for (const f of files) {
    const m = f.match(/^packages\/([^/]+)\//);
    if (m) pkgs.add(m[1]);
  }
  return pkgs;
}

function buildContext(config, { files, diff }) {
  const parts = [
    `# Changed files\n${files.map((f) => `- ${f}`).join("\n")}`,
    `# Diff\n\`\`\`diff\n${diff}\n\`\`\``,
  ];

  const ctxFiles = new Set(filesMatching(ROOT, config.contextGlobs ?? []));
  if (config.includePackageSpecs) {
    for (const pkg of changedPackages(files)) {
      for (const spec of PACKAGE_SPECS[pkg] ?? [])
        ctxFiles.add(`docs/specs/${spec}`);
    }
    ctxFiles.add("docs/specs/runtime-overview.md");
  }
  for (const rel of ctxFiles) {
    const body = readTruncated(join(ROOT, rel));
    if (body) parts.push(`# Context: ${rel}\n\`\`\`\n${body}\n\`\`\``);
  }
  return parts.join("\n\n");
}

const OUTPUT_CONTRACT = `
# Output contract (STRICT)
Respond with ONLY a JSON array of findings — no prose, and no markdown fences, before or after.
The response MUST be a JSON array even for a single finding — wrap it as [ { ... } ], never a bare object.
Each element of the array is one finding object:
{ "severity": "blocking" | "info", "file": "<repo-relative path>", "line": <int or null>, "message": "<one sentence>", "suggestion": "<optional fix>" }
Emit "blocking" ONLY for issues your role is defined to block on. When in doubt, use "info".
If you find nothing worth reporting, respond with exactly: []
Signal over volume — a false positive costs the reader's trust. Prefer fewer, high-confidence findings.`;

function composePrompt(config, context) {
  return [
    config.systemPrompt,
    config.examples ? `\n# Examples\n${config.examples}` : "",
    OUTPUT_CONTRACT,
    `\n# Review this change\n${context}`,
  ].join("\n");
}

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
  console.log(
    `review-agents: ${files.length} file(s) changed; running ${relevant.length}/${specialists.length} specialist(s)` +
      (isMock() ? " [MOCK]" : "") +
      `\n  base=${base.slice(0, 12)} sha=${sha.slice(0, 12)}`,
  );

  const runs = await Promise.all(
    relevant.map(async (config) => {
      const started = Date.now();
      const context = buildContext(config, { files, diff });
      if (opts.explain) {
        console.log(
          `\n──── context for ${config.id} ────\n${context.slice(0, 4000)}\n────────────────`,
        );
      }
      const res = runSpecialist({
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
      const raw = extractJsonArray(res.text);
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
        durationMs,
        findings,
      };
    }),
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
    const reportDir = join(ROOT, ".review-agents");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, `report-${sha}.json`),
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
