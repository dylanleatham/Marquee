// The retro: reading the harness's own evidence and proposing what to change.
//
// dev-harness §12 says to add checks when a bug ships and delete them when they generate more noise
// than signal. Phases 1 and 2 built the instruments — a ledger of triaged verdicts, and an eval that
// scores the roster — and this is the thing that reads them back.
//
// **It proposes; it never accepts.** Nothing here edits a prompt, a config, or an example. It writes
// a markdown file a human reads. That is the accept step from Self-Harness's propose → validate →
// accept loop (docs/specs/harness-self-improvement.md §2), and it is deliberate: an agent that can
// silently rewrite the standards it is judged against has no standards. The validation step is the
// eval, which any change born here still has to pass.
//
// Everything in this module is pure — it takes records, commits, a baseline and a case list, and
// returns proposals. `retro.mjs` is the CLI that gathers those from disk and writes the file.

import { computeStats, MIN_SAMPLE } from "./ledger.mjs";
import { detectionRate } from "./eval.mjs";

/** How stale a baseline may get before the retro says to re-measure it. */
export const BASELINE_STALE_DAYS = 14;

/** Below this many must-not-find cases, no claim about false positives is worth making. */
export const MIN_CLEAN_CASES = 6;

const proposal = (kind, severity, title, detail, evidence = []) => ({
  kind,
  severity,
  title,
  detail,
  evidence,
});

/**
 * A finding class raised more than once is a blind spot, not bad luck.
 *
 * The split matters and is the reason the ledger types its verdicts: a class repeatedly **accepted**
 * means the reviewer keeps being right about something the codebase keeps doing — the durable fix is
 * a gate, not a reviewer that catches it a fourth time. A class repeatedly **wrong** is the
 * reviewer's own problem, and is what §12's delete rule is for.
 */
export function repeatClassProposals(stats) {
  const out = [];
  for (const r of stats.repeats) {
    if (r.accepted >= 2 && r.wrong === 0)
      out.push(
        proposal(
          "close-a-gap",
          "act",
          `${r.specialist} has been right ${r.accepted} times about the same thing`,
          "A class that keeps being accepted is a missing gate. Close it with a test, a bounded " +
            "helper, or a lint rule, so a reviewer does not have to catch it a fourth time.",
          [`×${r.count}: ${r.example}`],
        ),
      );
    else if (r.wrong >= 2 && r.accepted === 0)
      out.push(
        proposal(
          "fix-a-prompt",
          "act",
          `${r.specialist} has been wrong ${r.wrong} times about the same thing`,
          "A class that keeps being wrong is a prompt to fix or a reviewer to retire (dev-harness " +
            "§12). Add it to the specialist's examples as a non-finding, then re-run the eval to " +
            "confirm the change costs no recall.",
          [`×${r.count}: ${r.example}`],
        ),
      );
  }
  return out;
}

/** Reviewers whose measured precision has gone bad, with enough evidence to say so. */
export function precisionProposals(stats, { floor = 0.5 } = {}) {
  return stats.specialists
    .filter((s) => s.precision !== null && s.precision < floor)
    .map((s) =>
      proposal(
        "fix-a-prompt",
        "act",
        `${s.id} is right ${Math.round(s.precision * 100)}% of the time (n=${s.judged})`,
        "dev-harness §12: a reviewer that fires often and is usually wrong is worse than no " +
          "reviewer. Refine the prompt or retire it — and either way the eval is what proves the " +
          "change helped.",
        [`${s.accepted} accepted, ${s.wrong} wrong, ${s.wontFix} won't-fix`],
      ),
    );
}

/**
 * Reviewers that have run and never once fired.
 *
 * Not automatically a fault — `security` finding nothing is good news — but a reviewer that has
 * never produced a finding is also indistinguishable from one that is broken, which is the whole
 * lesson of `null-result` scoring 0/9 and then 16/20.
 */
export function silentReviewerProposals(stats, { minRuns = 5 } = {}) {
  return stats.specialists
    .filter((s) => s.runs >= minRuns && s.fired === 0)
    .map((s) =>
      proposal(
        "verify-a-reviewer",
        "consider",
        `${s.id} has run ${s.runs} times and never fired`,
        "That is either good news or a broken reviewer, and from the outside they look the same. " +
          "An eval case is what tells them apart.",
        [`${s.runs} runs, 0 findings`],
      ),
    );
}

/** Escaped bugs with no eval case — §12's "add checks when a bug ships", made checkable. */
export function uncoveredEscapeProposals(fixCommits, cases) {
  const covered = new Set(
    cases.flatMap((c) => {
      const m = /commit:([0-9a-f]+)/i.exec(c.source ?? "");
      return m ? [m[1].slice(0, 7)] : [];
    }),
  );
  return fixCommits
    .filter((c) => !covered.has(c.sha.slice(0, 7)))
    .map((c) =>
      proposal(
        "add-a-case",
        "consider",
        `${c.sha.slice(0, 7)} fixed a bug that has no eval case`,
        "Every fix(...) commit is a bug that got past the reviewers, so its reverse diff is a " +
          "candidate case. Check the reversal produces the shape the reviewer is scoped for — a " +
          "fix that reconciled every copy reverses into a self-consistent diff, and a reversed " +
          "guard-addition reads as a deliberate revert.",
        [c.subject],
      ),
    );
}

/** Specialists the eval does not cover at all: their rows read 0/0, which is not coverage. */
export function coverageProposals(baseline, specialistIds, cases = []) {
  // No baseline is not thin coverage, it is no measurement — and reporting "only 0 must-not-find
  // cases" against a baseline that does not exist would be inventing a finding out of missing data,
  // which is the failure this whole document is about.
  if (!baseline?.specialists)
    return [
      proposal(
        "re-measure",
        "act",
        "no baseline has been recorded",
        "Nothing here can say whether the roster is getting better or worse until one exists. " +
          "Record it with `node review-agents/eval/run.mjs --repeat 5 --write-baseline`.",
        [],
      ),
    ];

  const scored = new Set(Object.keys(baseline.specialists));
  const withCases = new Set(cases.map((c) => c.specialist));
  const out = [];
  for (const id of specialistIds) {
    if (scored.has(id)) continue;
    // Two different states with two different actions. "No cases exist" means write some; "cases
    // exist but the baseline predates them" means re-measure — and telling someone to write cases
    // they already wrote is how a proposal file teaches people to skim it.
    if (withCases.has(id))
      out.push(
        proposal(
          "re-measure",
          "act",
          `${id} has cases the baseline has never scored`,
          "The cases are on disk and the recorded floor predates them, so nothing is comparing " +
            "them to anything. Re-record with `--repeat 5 --write-baseline`.",
          [
            `${cases.filter((c) => c.specialist === id).length} case(s) unscored`,
          ],
        ),
      );
    else
      out.push(
        proposal(
          "add-a-case",
          "act",
          `${id} has no eval coverage at all`,
          "No cases exist for it. Its row reads 0/0, which is honest and is not coverage — " +
            "nothing would notice if an edit to this reviewer broke it.",
          [],
        ),
      );
  }

  // Counted from the cases on disk, not the baseline: the suite is what exists, and a baseline that
  // has not caught up is the *other* proposal above.
  const clean = cases.filter((c) => c.kind === "must-not-find").length;
  if (clean < MIN_CLEAN_CASES)
    out.push(
      proposal(
        "add-a-case",
        "act",
        `only ${clean} must-not-find case(s) in the whole suite`,
        `Every claim this harness makes about false positives rests on those ${clean}. Sampling ` +
          "and union (ADR 0088) is exactly the change that turns a rare per-run false positive " +
          "into a frequent per-review one, and nothing here could currently detect that.",
        [],
      ),
    );
  return out;
}

/**
 * A baseline older than `BASELINE_STALE_DAYS` should be re-measured rather than trusted.
 *
 * Learned the hard way: `null-result` scored 0/9 on 2026-08-13 and 16/20 on 2026-08-14 with no
 * change to its prompt or config, and the mechanical explanation was tested and refuted. Whatever
 * moved, a recorded number here has a shelf life, and a gate comparing today against a month-old
 * floor is comparing against a different world.
 */
export function baselineAgeProposals(baseline, now) {
  if (!baseline?.generatedAt) return [];
  const days = (now - Date.parse(baseline.generatedAt)) / 86_400_000;
  if (days < BASELINE_STALE_DAYS) return [];
  return [
    proposal(
      "re-measure",
      "act",
      `the baseline is ${Math.floor(days)} days old`,
      "Re-record it with `--repeat 5 --write-baseline`. These numbers have been observed to move " +
        "by 80 points in a day with no code change, so an old floor is not a floor.",
      [`generated ${baseline.generatedAt}`],
    ),
  ];
}

/** Everything the evidence on disk supports, most actionable first. */
export function buildRetro({
  ledger = [],
  fixCommits = [],
  baseline = null,
  cases = [],
  specialistIds = [],
  now = 0,
} = {}) {
  const stats = computeStats(ledger);
  const proposals = [
    ...repeatClassProposals(stats),
    ...precisionProposals(stats),
    ...coverageProposals(baseline, specialistIds, cases),
    ...baselineAgeProposals(baseline, now),
    ...silentReviewerProposals(stats),
    ...uncoveredEscapeProposals(fixCommits, cases),
  ];
  const order = { act: 0, consider: 1 };
  proposals.sort((a, b) => order[a.severity] - order[b.severity]);
  return { stats, proposals };
}

/**
 * The proposal file.
 *
 * Written as something to read and act on, not as a report to file away — every entry names what to
 * do, and the header says plainly that nothing was changed.
 */
export function formatRetro({ stats, proposals }, { date, baseline } = {}) {
  const out = [
    `# Harness retro — ${date}`,
    "",
    "_Generated by `pnpm run review:retro`. **Nothing has been changed.** This proposes; you accept._",
    "",
    "Any change made from this file still has to pass `pnpm run review:eval` against the committed",
    "baseline — that is the validation half, and it is the reason a retro is allowed to be wrong.",
    "",
    "## What the evidence says",
    "",
    `- Ledger: ${stats.totals.triaged} triaged finding(s) across ${stats.totals.runs} run(s).`,
    `- Baseline: ${baseline?.generatedAt ?? "none recorded"}.`,
    `- Reviewers with enough judged findings to have a precision figure (n≥${MIN_SAMPLE}): ` +
      `${stats.specialists.filter((s) => s.precision !== null).length}/${stats.specialists.length}.`,
    "",
  ];

  if (!proposals.length) {
    out.push(
      "## Proposals",
      "",
      "None. That is a real answer only if the ledger above has enough in it to be worth reading —",
      "an empty ledger produces an empty retro, and the two look identical from here.",
    );
    return out.join("\n");
  }

  const act = proposals.filter((p) => p.severity === "act");
  const consider = proposals.filter((p) => p.severity === "consider");
  const section = (title, items) => {
    if (!items.length) return;
    out.push(`## ${title}`, "");
    for (const p of items) {
      out.push(`### ${p.title}`, "", `_${p.kind}_ — ${p.detail}`, "");
      for (const e of p.evidence) out.push(`> ${e}`, "");
    }
  };
  section("Act on these", act);
  section("Worth considering", consider);
  return out.join("\n");
}
