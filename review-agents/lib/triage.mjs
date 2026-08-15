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
 * The report to triage: the one for the current commit if it exists, otherwise the most recently
 * written one.
 *
 * The fallback matters more than it looks. You review, you fix what it found, you commit — and now
 * `currentSha()` names a commit the report was never written for. Refusing to triage at that point
 * would mean the harness only remembers findings you didn't act on, which inverts the measurement.
 *
 * @returns {{ path: string, report: object, forCurrentSha: boolean } | null}
 */
export function resolveReport(reportDir, sha) {
  if (!existsSync(reportDir)) return null;
  const exact = join(reportDir, `report-${sha}.json`);
  if (existsSync(exact))
    return { path: exact, report: readReport(exact), forCurrentSha: true };

  const reports = readdirSync(reportDir)
    .filter((f) => /^report-.*\.json$/.test(f))
    .map((f) => join(reportDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!reports.length) return null;
  return {
    path: reports[0],
    report: readReport(reports[0]),
    forCurrentSha: false,
  };
}

function readReport(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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
