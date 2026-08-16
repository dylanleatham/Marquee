// Triage: turning a review you just read into evidence the harness keeps.
//
// The verdict has to be captured while judging is still cheap — thirty seconds after the review,
// with the diff still in your head. So this is a terminal pass over the findings of the most recent
// report, one keypress each, and it **appends after every verdict** rather than at the end: an
// interrupted triage keeps everything already judged, and re-running it resumes where it stopped
// (`pendingFindings`). Design: docs/specs/harness-self-improvement.md §4.1, open question 2.
//
// A note is asked for only on `wrong`. That is the verdict whose *reason* is actionable — it is
// what a prompt fix or a retirement under dev-harness §12 gets argued from. Asking for prose on
// every finding would make the common case slower, and a triage nobody runs measures nothing.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  pendingFindings,
  findingRecord,
  runRecord,
  runIdOf,
} from "./ledger.mjs";

/**
 * Keystroke → verdict. Every verdict the ledger defines must be reachable from here: a verdict with
 * no key can never be recorded, which would be a category the stats silently under-count. A test
 * pins the two lists together.
 */
export const CHOICES = new Map([
  ["a", "accepted"],
  ["w", "wrong"],
  ["x", "wont-fix"],
]);

/**
 * The file a review's report is written to.
 *
 * Keyed on the **review**, not the commit. `report-${sha}.json` collided whenever one commit was
 * reviewed twice — which is the normal case, because CLAUDE.md asks you to run the reviewers in the
 * inner loop and iterate, and a branch with no commits yet resolves to the same base SHA every
 * time. The second review overwrote the first's findings before anyone could judge them
 * (issue #330).
 *
 * This is RA-6's other half. That fixed run identity *in the ledger* — `runIdOf` keys on
 * `createdAt` — and left the file feeding it still colliding, so the input was destroyed before the
 * ledger ever saw it.
 *
 * The run id is hashed rather than pasted in: it is an ISO timestamp, and `:` is not legal in a
 * Windows filename. The sha stays in the name so the directory is still readable by eye.
 */
export function reportFileName(report) {
  const runId = createHash("sha1")
    .update(runIdOf(report))
    .digest("hex")
    .slice(0, 8);
  return `report-${report.sha}-${runId}.json`;
}

/**
 * Every review still owing a verdict, oldest first.
 *
 * A review is owed one if it has findings not yet in the ledger, **or** if its run was never
 * recorded — a findings-free review is a real data point, and dropping it would bias every
 * specialist's fire rate upward by removing the quiet runs from the denominator.
 *
 * Oldest first because that is the order they happened in, and a triage pass reads as a story of
 * the branch. Ordering on `createdAt` rather than mtime keeps that true when reports are copied
 * around (restored from another machine, or rebuilt from a transcript).
 *
 * The previous `resolveReport` returned exactly one — the newest — so even reports that survived
 * the collision above could not all be reached.
 *
 * @returns {{ path: string, report: object, forCurrentSha: boolean }[]}
 */
export function resolveReports(
  reportDir,
  sha,
  records = [],
  onSkip = () => {},
) {
  if (!existsSync(reportDir)) return [];

  const owed = readdirSync(reportDir)
    .filter((f) => /^report-.*\.json$/.test(f))
    .map((f) => {
      const path = join(reportDir, f);
      const report = readReport(path);
      if (!report) {
        onSkip(path);
        return null;
      }
      return { path, report, mtime: statSync(path).mtimeMs };
    })
    .filter(Boolean)
    .filter(({ report }) => {
      if (pendingFindings(report, records).length) return true;
      const runId = runIdOf(report);
      return !records.some((r) => r.kind === "run" && r.runId === runId);
    });

  owed.sort(
    (a, b) =>
      String(a.report.createdAt ?? "").localeCompare(
        String(b.report.createdAt ?? ""),
      ) || a.mtime - b.mtime,
  );

  return owed.map(({ path, report }) => ({
    path,
    report,
    forCurrentSha: report.sha === sha,
  }));
}

/**
 * Parse one report, or `null` if it cannot be parsed.
 *
 * Tolerant because `resolveReports` reads *every* report in the directory: a single truncated file
 * — what a killed review leaves behind — would otherwise take the whole triage pass down with it,
 * and the findings you could still have judged with it. Skipped files are reported by the caller
 * rather than swallowed; a directory quietly losing half its reports is the silent-green failure
 * dev-harness §11 exists to prevent.
 */
function readReport(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** One finding, rendered for a human about to judge it. Severity is spelled out, never a colour. */
export function renderFinding(finding, index, total) {
  const where =
    finding.line === null || finding.line === undefined
      ? finding.file
      : `${finding.file}:${finding.line}`;
  const lines = [
    "",
    `── ${index + 1}/${total} ──────────────────────────────────────────────`,
    `  ${finding.specialist}  [${finding.severity}]`,
    `  ${where}`,
    `  ${finding.message}`,
  ];
  if (finding.suggestion) lines.push(`  suggestion: ${finding.suggestion}`);
  return lines.join("\n");
}

export const TRIAGE_HELP =
  "  [a] accepted — real, I changed the code\n" +
  "  [w] wrong    — not a real problem (you'll be asked why)\n" +
  "  [x] wont-fix — real, but deliberately not acting on it\n" +
  "  [s] skip     — decide later; re-run --triage to be asked again\n" +
  "  [q] quit     — stop here, keeping every verdict already given";

/**
 * Walk the untriaged findings of a report, appending each verdict as it is given.
 *
 * `ask`, `append` and `now` are injected so the whole loop is unit-testable without a TTY, a
 * ledger file, or a clock.
 *
 * @returns {{ judged: number, skipped: number, quit: boolean, alreadyDone: number }}
 */
export async function runTriage({
  report,
  records,
  ask,
  append,
  now = () => new Date().toISOString(),
  log = console.log,
}) {
  const pending = pendingFindings(report, records);
  const total = (report.findings ?? []).length;
  const alreadyDone = total - pending.length;

  // The run record is the denominator — how often each specialist ran, and how often it fired at
  // all. Written once per *review*, before any verdict, so a triage abandoned immediately still
  // records that the review happened. Keyed on `runIdOf`, not sha: one commit can be reviewed
  // twice against different bases, and keying on sha silently dropped the second.
  const runId = runIdOf(report);
  const haveRun = records.some((r) => r.kind === "run" && r.runId === runId);
  if (!haveRun) append([runRecord({ report, ts: now() })]);

  if (!pending.length) {
    log(
      total
        ? `review-agents: all ${total} finding(s) in this report are already in the ledger.`
        : "review-agents: this report has no findings to triage (the run itself is recorded).",
    );
    return { judged: 0, skipped: 0, quit: false, alreadyDone };
  }

  log(
    `\nreview-agents: triaging ${pending.length} finding(s)` +
      (alreadyDone ? ` (${alreadyDone} already judged)` : "") +
      `.\n${TRIAGE_HELP}`,
  );

  let judged = 0;
  let skipped = 0;
  for (const [i, finding] of pending.entries()) {
    log(renderFinding(finding, i, pending.length));
    const answer = await ask("  verdict [a/w/x/s/q]: ");
    // Ctrl+D closes stdin and readline answers with nothing. Treat end-of-input as quit rather
    // than throwing on `.trim()` — everything judged so far is already on disk, and losing the
    // session to a stack trace at that point would be the worst possible moment for one.
    if (answer === undefined || answer === null)
      return { judged, skipped, quit: true, alreadyDone };
    const key = String(answer).trim().toLowerCase();

    if (key === "q") return { judged, skipped, quit: true, alreadyDone };
    if (key === "s" || !CHOICES.has(key)) {
      // An unrecognised key skips rather than guessing. A mistyped verdict written to an
      // append-only log is worse than being asked again next time.
      if (key && key !== "s") log(`  (unrecognised '${key}' — skipped)`);
      skipped++;
      continue;
    }

    const verdict = CHOICES.get(key);
    const note =
      verdict === "wrong"
        ? (await ask("  why was it wrong? (one line, optional): ")).trim()
        : "";
    append([
      findingRecord({
        sha: report.sha,
        runId,
        finding,
        verdict,
        note,
        ts: now(),
      }),
    ]);
    judged++;
  }
  return { judged, skipped, quit: false, alreadyDone };
}
