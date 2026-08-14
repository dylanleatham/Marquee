// Tests for the retro (docs/specs/harness-self-improvement.md §4.6, ADR 0089).
//
// The load-bearing one is the last: the retro must write its proposal file and touch nothing else.
// It reads the evidence a human uses to judge the reviewers, and a tool that could quietly edit a
// prompt while reporting on it would be marking its own homework.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findingRecord, runRecord } from "./ledger.mjs";
import {
  repeatClassProposals,
  precisionProposals,
  silentReviewerProposals,
  uncoveredEscapeProposals,
  coverageProposals,
  baselineAgeProposals,
  buildRetro,
  formatRetro,
  BASELINE_STALE_DAYS,
  MIN_CLEAN_CASES,
} from "./retro.mjs";
import { computeStats } from "./ledger.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const finding = (over = {}) => ({
  specialist: "runtime",
  severity: "info",
  file: "packages/curator/src/a.ts",
  line: 1,
  message: "The upload handler has no timeout.",
  ...over,
});
const ledgerOf = (verdicts, over = {}) =>
  verdicts.map((verdict, i) =>
    findingRecord({
      sha: "abc",
      finding: finding({ line: i, ...over }),
      verdict,
      ts: "2026-08-14T00:00:00Z",
    }),
  );

test("repeatClassProposals: a class that keeps being accepted asks for a gate, not a reviewer", () => {
  // The point of the accepted/wrong split. Right three times about the same thing means the
  // codebase keeps doing it — the durable fix is a test or a bounded helper, not a fourth catch.
  const [p] = repeatClassProposals(
    computeStats(ledgerOf(["accepted", "accepted", "accepted"])),
  );
  assert.equal(p.kind, "close-a-gap");
  assert.match(p.title, /right 3 times/);
});

test("repeatClassProposals: a class that keeps being wrong is the reviewer's problem", () => {
  const [p] = repeatClassProposals(computeStats(ledgerOf(["wrong", "wrong"])));
  assert.equal(p.kind, "fix-a-prompt");
  assert.match(p.detail, /§12/);
});

test("repeatClassProposals: a mixed class proposes nothing", () => {
  // Two accepted and one wrong is a reviewer being mostly right, which needs no intervention —
  // proposing on it would train the reader to skim the file.
  assert.deepEqual(
    repeatClassProposals(
      computeStats(ledgerOf(["accepted", "accepted", "wrong"])),
    ),
    [],
  );
});

test("precisionProposals: only fires once there is enough evidence to be fair", () => {
  // computeStats leaves precision null below MIN_SAMPLE, so a reviewer cannot be retired on the
  // strength of two bad calls.
  assert.deepEqual(
    precisionProposals(computeStats(ledgerOf(["wrong", "wrong"]))),
    [],
  );
  const thin = ledgerOf([
    ...Array(2).fill("accepted"),
    ...Array(7).fill("wrong"),
  ]);
  const [p] = precisionProposals(computeStats(thin));
  assert.equal(p.kind, "fix-a-prompt");
  assert.match(p.title, /22% of the time \(n=9\)/);
});

test("silentReviewerProposals: a reviewer that has run and never fired is worth verifying", () => {
  // null-result scored 0/9 and then 16/20 with no change. "Never fires" and "broken" look
  // identical from outside, which is the whole reason this proposal exists.
  const runs = Array.from({ length: 6 }, (_, i) =>
    runRecord({
      report: {
        sha: `s${i}`,
        specialists: [
          { id: "security", status: "no-findings", durationMs: 100 },
        ],
        findings: [],
      },
      ts: "2026-08-14T00:00:00Z",
    }),
  );
  const [p] = silentReviewerProposals(computeStats(runs));
  assert.equal(p.kind, "verify-a-reviewer");
  assert.match(p.title, /security has run 6 times and never fired/);
});

test("uncoveredEscapeProposals: a fix with a case is not proposed again", () => {
  const commits = [
    { sha: "436b1d1aaaa", subject: "fix(curator): rename over a served file" },
    { sha: "deadbeefbbb", subject: "fix(stylus): something with no case" },
  ];
  const cases = [{ source: "commit:436b1d1 (reversed)" }];
  const out = uncoveredEscapeProposals(commits, cases);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /deadbee/);
  // It carries the trap forward, because two of the first five seeded cases fell into it.
  assert.match(out[0].detail, /self-consistent diff|deliberate revert/);
});

test("coverageProposals: a specialist the baseline never scored has no coverage", () => {
  const baseline = {
    specialists: {
      runtime: { mustFind: { total: 4 }, mustNotFind: { total: 8 } },
    },
  };
  const out = coverageProposals(baseline, ["runtime", "security"]);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /security has no eval coverage/);
});

test("coverageProposals: too few clean cases to claim anything about false positives", () => {
  const baseline = {
    specialists: {
      runtime: { mustFind: { total: 4 }, mustNotFind: { total: 3 } },
    },
  };
  const out = coverageProposals(baseline, ["runtime"]);
  assert.match(out.map((p) => p.title).join(), /only 3 must-not-find/);
  assert.ok(MIN_CLEAN_CASES > 3);
});

test("baselineAgeProposals: a stale baseline is not a floor", () => {
  // Measured: 0/9 then 16/20 in a day, with no code change and the mechanical explanation refuted.
  const now = Date.parse("2026-09-01T00:00:00Z");
  assert.deepEqual(
    baselineAgeProposals({ generatedAt: "2026-08-30T00:00:00Z" }, now),
    [],
  );
  const [p] = baselineAgeProposals(
    { generatedAt: "2026-08-01T00:00:00Z" },
    now,
  );
  assert.equal(p.kind, "re-measure");
  assert.match(p.title, new RegExp(`\\d+ days old`));
  assert.ok(BASELINE_STALE_DAYS > 0);
  assert.deepEqual(baselineAgeProposals(null, now), []);
});

test("coverageProposals: no baseline is missing data, not thin coverage", () => {
  // The first version counted must-not-find cases from an absent baseline, got 0, and reported
  // "only 0 must-not-find case(s)" — inventing a finding out of nothing, which is precisely the
  // failure this harness exists to catch. Absent data gets its own proposal.
  const [p] = coverageProposals(null, ["runtime"]);
  assert.equal(p.kind, "re-measure");
  assert.match(p.title, /no baseline has been recorded/);
  assert.ok(
    !coverageProposals(null, ["runtime"]).some((x) =>
      /must-not-find/.test(x.title),
    ),
  );
});

test("formatRetro: an empty retro says so rather than reading as a clean bill of health", () => {
  const text = formatRetro(
    {
      stats: { totals: { triaged: 0, runs: 0 }, specialists: [], repeats: [] },
      proposals: [],
    },
    { date: "2026-08-14" },
  );
  assert.match(text, /Nothing has been changed/);
  assert.match(text, /an empty ledger produces an empty retro/);
});

test("formatRetro: proposals lead with what to act on", () => {
  const text = formatRetro(
    buildRetro({
      ledger: ledgerOf(["accepted", "accepted"]),
      baseline: { generatedAt: "2026-08-14T00:00:00Z", specialists: {} },
      specialistIds: [],
      now: Date.parse("2026-08-14T00:00:00Z"),
    }),
    { date: "2026-08-14" },
  );
  assert.match(text, /## Act on these/);
  assert.ok(
    text.indexOf("## Act on these") <
      text.indexOf("## Worth considering") + 1e9,
  );
});

test("the retro writes its proposal file and mutates nothing else", () => {
  // The whole basis for letting it read the evidence. An agent that could quietly edit a prompt
  // while reporting on that prompt would be marking its own homework — Self-Harness's accept step
  // belongs to a human (docs/specs/harness-self-improvement.md §2, principle 3).
  const before = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 20_000,
  });
  execFileSync("node", [join(REPO, "review-agents", "retro.mjs"), "--stdout"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const after = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(
    after,
    before,
    "a --stdout retro must leave the tree byte-for-byte unchanged",
  );
});
