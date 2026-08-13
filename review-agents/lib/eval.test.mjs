// Tests for the eval scoring logic (docs/specs/harness-self-improvement.md §4.2).
//
// Separate from lib.test.mjs, which is already 800 lines. Everything here is pure: no Claude
// session, no case files on disk, so it runs in CI like any other unit test. The half that spends
// tokens is eval/run.mjs, and it runs locally only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateCase,
  filesFromPatch,
  matchesExpect,
  scoreCase,
  majorityOutcome,
  cacheKey,
  cachePolicy,
  detectionRate,
  rateTolerance,
  baselineLacksRates,
  summarizeEval,
  toBaseline,
  compareBaseline,
  formatEval,
} from "./eval.mjs";

const EVAL_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "eval");
const CASES_DIR = join(EVAL_DIR, "cases");

// --- case definitions -----------------------------------------------------------------------

test("validateCase: a must-find case with no expect cannot pass for the right reason", () => {
  // An empty `expect` would make any finding at all count as a hit, so the case would go green
  // while measuring nothing — the failure dev-harness §11 exists to forbid, aimed at the eval.
  const problems = validateCase({
    id: "x",
    kind: "must-find",
    specialist: "runtime",
    expect: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /would count as a hit/);
});

test("validateCase: catches a bad kind, a missing specialist, and an id that lies", () => {
  assert.match(
    validateCase({ id: "x", kind: "should-find", specialist: "r" }).join(),
    /"kind" must be one of/,
  );
  assert.match(
    validateCase({ id: "x", kind: "must-not-find" }).join(),
    /missing "specialist"/,
  );
  assert.match(
    validateCase(
      { id: "other", kind: "must-not-find", specialist: "r" },
      { id: "x" },
    ).join(),
    /but the directory is "x"/,
  );
});

test("validateCase: an unparseable regex is a broken case, not a case that never matches", () => {
  const problems = validateCase({
    id: "x",
    kind: "must-find",
    specialist: "runtime",
    expect: { matches: ["( unclosed"] },
  });
  assert.match(problems.join(), /not a valid regular expression/);
});

test("validateCase: a well-formed case has no problems", () => {
  assert.deepEqual(
    validateCase(
      {
        id: "x",
        kind: "must-find",
        specialist: "runtime",
        expect: { file: "a/b.ts", matches: ["timeout"] },
      },
      { id: "x" },
    ),
    [],
  );
});

// --- patch parsing --------------------------------------------------------------------------

test("filesFromPatch: a reversed diff writes +++ a/… , and its paths must still resolve", () => {
  // The bug this pins: stripping only `b/` yielded "a/docs/specs/x.md", which matched no exclusion
  // glob, so --exclude silently kept the test files whose names hand the reviewer the answer.
  const reversed = [
    "diff --git b/packages/stylus/stylus/reader.py a/packages/stylus/stylus/reader.py",
    "--- b/packages/stylus/stylus/reader.py",
    "+++ a/packages/stylus/stylus/reader.py",
    "@@ -1 +1 @@",
  ].join("\n");
  assert.deepEqual(filesFromPatch(reversed), [
    "packages/stylus/stylus/reader.py",
  ]);
});

test("filesFromPatch: a section that only deletes a file still names it", () => {
  // `+++ /dev/null` names nothing, so the `diff --git` header is the only source. A reversed diff
  // deletes every file the fix added, so this is the common case, not an edge one.
  const deletion = [
    "diff --git b/packages/stylus/stylus/bounded.py a/packages/stylus/stylus/bounded.py",
    "deleted file mode 100644",
    "--- b/packages/stylus/stylus/bounded.py",
    "+++ /dev/null",
  ].join("\n");
  assert.deepEqual(filesFromPatch(deletion), [
    "packages/stylus/stylus/bounded.py",
  ]);
});

test("filesFromPatch: an empty or absent patch touches nothing", () => {
  assert.deepEqual(filesFromPatch(""), []);
  assert.deepEqual(filesFromPatch(undefined), []);
});

// --- matching and scoring -------------------------------------------------------------------

const finding = (over = {}) => ({
  specialist: "runtime",
  severity: "info",
  file: "packages/curator/src/albums/actions.ts",
  line: 12,
  message: "renameSync onto a path Curator may still be serving is a race.",
  ...over,
});

test("matchesExpect: a partial path from the model still matches the expected file", () => {
  // Models reply with "src/albums/actions.ts" about as often as the full repo-relative path.
  assert.ok(matchesExpect(finding(), { file: "src/albums/actions.ts" }));
  assert.ok(
    matchesExpect(finding({ file: "actions.ts" }), {
      file: "packages/curator/src/albums/actions.ts",
    }),
  );
  assert.ok(
    !matchesExpect(finding(), { file: "packages/curator/src/media/video.ts" }),
  );
});

test("matchesExpect: expect.file may list several legitimate sites", () => {
  // The first real eval run scored a false miss because of this: `runtime` reported the
  // rename-over-a-served-file race at media/video.ts while the case pinned albums/actions.ts. Both
  // call sites carry the bug. A baseline built from that would have recorded a recall gap that does
  // not exist — and the gate would then protect the wrong number.
  const expect = {
    file: [
      "packages/curator/src/albums/actions.ts",
      "packages/curator/src/media/video.ts",
    ],
  };
  assert.ok(matchesExpect(finding(), expect));
  assert.ok(
    matchesExpect(
      finding({ file: "packages/curator/src/media/video.ts" }),
      expect,
    ),
  );
  assert.ok(
    !matchesExpect(
      finding({ file: "packages/curator/src/roadie/steps.ts" }),
      expect,
    ),
  );
});

test("matchesExpect: patterns read the suggestion as well as the message", () => {
  const f = finding({
    message: "This overwrite is unsafe.",
    suggestion: "Use an atomic rename.",
  });
  assert.ok(matchesExpect(f, { matches: ["atomic"] }));
  assert.ok(!matchesExpect(f, { matches: ["timeout"] }));
});

test("scoreCase: a must-find case hits only on a finding that matches", () => {
  const def = { kind: "must-find", expect: { matches: ["race|EBUSY"] } };
  assert.equal(scoreCase(def, [finding()]).outcome, "hit");
  assert.equal(
    scoreCase(def, [finding({ message: "Naming drift." })]).outcome,
    "miss",
  );
  assert.equal(scoreCase(def, []).outcome, "miss");
});

test("scoreCase: a must-not-find case fails on a blocking finding, not on an info one", () => {
  // Counting every info finding as a false positive would make the metric unusable — a reviewer
  // noticing something true-but-minor is doing its job. A *blocking* finding on a clean diff is
  // what stops a push and teaches someone to reach for --no-verify.
  const def = { kind: "must-not-find" };
  assert.equal(scoreCase(def, [finding({ severity: "info" })]).outcome, "hit");
  assert.equal(
    scoreCase(def, [finding({ severity: "blocking" })]).outcome,
    "miss",
  );
  assert.equal(scoreCase(def, []).outcome, "hit");
});

test("scoreCase: an explicit forbid pattern catches an info finding too", () => {
  const def = { kind: "must-not-find", forbid: ["naming drift"] };
  assert.equal(
    scoreCase(def, [finding({ message: "Naming drift here." })]).outcome,
    "miss",
  );
  assert.equal(scoreCase(def, [finding()]).outcome, "hit");
});

// --- repeats --------------------------------------------------------------------------------

test("majorityOutcome: a majority of runs decides, because one run is not a measurement", () => {
  assert.equal(majorityOutcome(["hit", "hit", "miss"]).outcome, "hit");
  assert.equal(majorityOutcome(["hit", "miss", "miss"]).outcome, "miss");
  assert.equal(majorityOutcome(["hit"]).outcome, "hit");
  // An exact tie is not a majority — it stays a miss rather than being rounded up in the
  // reviewer's favour.
  assert.equal(majorityOutcome(["hit", "miss"]).outcome, "miss");
  assert.deepEqual(majorityOutcome(["hit", "hit", "miss"]), {
    outcome: "hit",
    hits: 2,
    runs: 3,
  });
});

test("majorityOutcome: a structural outcome cannot be voted away", () => {
  // Re-running a case whose specialist never sees the files cannot change the answer, and calling
  // it a "miss" would blame the prompt for what is a routing bug (issue #192).
  assert.equal(majorityOutcome(["not-triggered"]).outcome, "not-triggered");
  assert.equal(
    majorityOutcome(["hit", "not-installed", "hit"]).outcome,
    "not-installed",
  );
  assert.equal(majorityOutcome([]).outcome, "miss");
});

// --- caching --------------------------------------------------------------------------------

const specialist = {
  id: "runtime",
  model: "sonnet",
  blocking: true,
  systemPrompt: "you review runtime safety",
  examples: "an example",
  triggerGlobs: ["packages/**/*.ts"],
};
const keyFor = (over = {}) =>
  cacheKey({
    caseJson: { id: "c" },
    patch: "diff",
    repeats: 3,
    specialist: { ...specialist, ...over },
  });

test("cacheKey: editing what the reviewer reads voids the cache", () => {
  const base = keyFor();
  assert.notEqual(base, keyFor({ systemPrompt: "reworded" }));
  assert.notEqual(base, keyFor({ examples: "a different example" }));
  assert.notEqual(base, keyFor({ model: "opus" }));
  assert.notEqual(base, keyFor({ triggerGlobs: ["packages/**/*.tsx"] }));
  assert.notEqual(base, keyFor({ blocking: false }));
});

test("cacheKey: an unrelated field does not, or the suite would never reuse anything", () => {
  // The point of the cache is that editing one reviewer does not re-run every other reviewer's
  // cases. A key that moved on any change at all would make the suite as expensive as --no-cache.
  assert.equal(keyFor(), keyFor({ timeoutMs: 300_000 }));
  assert.equal(keyFor(), keyFor({ id: "runtime" }));
});

test("cacheKey: the case, the diff and the repeat count are all part of it", () => {
  const args = { caseJson: { id: "c" }, patch: "diff", repeats: 3, specialist };
  assert.notEqual(cacheKey(args), cacheKey({ ...args, caseJson: { id: "d" } }));
  assert.notEqual(cacheKey(args), cacheKey({ ...args, patch: "other" }));
  assert.notEqual(cacheKey(args), cacheKey({ ...args, repeats: 5 }));
});

test("cachePolicy: a mock run neither reads nor writes the result cache", () => {
  // Found by doing it, 2026-08-13. A `REVIEW_MOCK=1` run seeded the cache with its canned empty
  // findings; the next *real* run read them back and printed `miss [cached]` without spending a
  // session. `cacheKey` cannot catch this — mock-ness lives in the environment, not in the case or
  // the reviewer — so the policy has to exclude mock runs outright.
  assert.deepEqual(cachePolicy({ mock: true }), { read: false, write: false });
  assert.deepEqual(cachePolicy({ mock: true, noCache: true }), {
    read: false,
    write: false,
  });
});

test("cachePolicy: --no-cache recomputes but still keeps the fresh real result", () => {
  assert.deepEqual(cachePolicy({}), { read: true, write: true });
  assert.deepEqual(cachePolicy({ noCache: true }), {
    read: false,
    write: true,
  });
});

// --- summary and baseline -------------------------------------------------------------------

const results = [
  { specialist: "runtime", kind: "must-find", outcome: "hit" },
  { specialist: "runtime", kind: "must-find", outcome: "miss" },
  { specialist: "runtime", kind: "must-not-find", outcome: "hit" },
  { specialist: "runtime", kind: "must-not-find", outcome: "miss" },
  { specialist: "test-auditor", kind: "must-find", outcome: "not-triggered" },
  { specialist: "doc-coherence", kind: "must-find", outcome: "not-installed" },
];

test("summarizeEval: recall, false positives, and the two structural outcomes are separate", () => {
  const summary = summarizeEval(results);
  const runtime = summary.find((s) => s.id === "runtime");
  // The fixture carries no hits/runs, so the run-level counters stay at zero — which is what
  // `detectionRate` reports as null rather than as a measured 0%.
  assert.deepEqual(runtime.mustFind, { hit: 1, total: 2, hits: 0, runs: 0 });
  assert.deepEqual(runtime.mustNotFind, {
    fp: 1,
    total: 2,
    fpRuns: 0,
    runs: 0,
  });
  assert.equal(detectionRate(runtime.mustFind), null);
  assert.equal(summary.find((s) => s.id === "test-auditor").notTriggered, 1);
  assert.equal(summary.find((s) => s.id === "doc-coherence").notInstalled, 1);
});

test("compareBaseline: a recall drop and an FP rise are both regressions", () => {
  const summary = summarizeEval(results);
  const baseline = toBaseline(summary, { repeats: 3, generatedAt: "t" });
  assert.ok(compareBaseline(summary, baseline).ok);

  const worseRecall = summarizeEval([
    { specialist: "runtime", kind: "must-find", outcome: "miss" },
    { specialist: "runtime", kind: "must-find", outcome: "miss" },
    { specialist: "runtime", kind: "must-not-find", outcome: "hit" },
    { specialist: "runtime", kind: "must-not-find", outcome: "miss" },
  ]);
  const r1 = compareBaseline(worseRecall, baseline);
  assert.ok(!r1.ok);
  assert.match(r1.regressions.join(), /recall fell — 1\/2 → 0\/2/);

  const worseFp = summarizeEval([
    { specialist: "runtime", kind: "must-find", outcome: "hit" },
    { specialist: "runtime", kind: "must-find", outcome: "miss" },
    { specialist: "runtime", kind: "must-not-find", outcome: "miss" },
    { specialist: "runtime", kind: "must-not-find", outcome: "miss" },
  ]);
  const r2 = compareBaseline(worseFp, baseline);
  assert.ok(!r2.ok);
  assert.match(r2.regressions.join(), /false positives rose — 1\/2 → 2\/2/);
});

test("compareBaseline: deleting a specialist's cases is a regression, not an improvement", () => {
  // The cheapest possible way to make any gate go green is to delete what it measures.
  const baseline = toBaseline(summarizeEval(results), {
    repeats: 3,
    generatedAt: "t",
  });
  const shrunk = summarizeEval(
    results.filter((r) => r.specialist !== "runtime"),
  );
  const cmp = compareBaseline(shrunk, baseline);
  assert.ok(!cmp.ok);
  assert.match(
    cmp.regressions.join(),
    /runtime: the baseline covers it .* this run scored none/,
  );
});

test("compareBaseline: no baseline is not a pass", () => {
  const cmp = compareBaseline(summarizeEval(results), null);
  assert.ok(!cmp.ok);
  assert.equal(cmp.reason, "no-baseline");
});

test("formatEval: the table spells out every column, and names a regression", () => {
  const summary = summarizeEval(results);
  const baseline = toBaseline(summary, {
    repeats: 3,
    generatedAt: "2026-08-13",
  });
  const clean = formatEval(summary, { repeats: 3, baseline });
  assert.match(clean, /RECALL/);
  assert.match(clean, /no regression/);

  const shrunk = summarizeEval(
    results.filter((r) => r.specialist !== "runtime"),
  );
  assert.match(formatEval(shrunk, { repeats: 3, baseline }), /REGRESSED/);
});

// --- the case set on disk -------------------------------------------------------------------

test("every case on disk is well-formed and has a diff that touches files", () => {
  // A malformed case is not a case the reviewer passed — the runner refuses to score a broken
  // suite, and this catches it in CI before anyone spends a session finding out.
  assert.ok(existsSync(CASES_DIR), "eval/cases/ must exist");
  const ids = readdirSync(CASES_DIR).filter((d) =>
    statSync(join(CASES_DIR, d)).isDirectory(),
  );
  assert.ok(ids.length > 0, "the case set must not be empty");
  for (const id of ids) {
    const def = JSON.parse(
      readFileSync(join(CASES_DIR, id, "case.json"), "utf8"),
    );
    assert.deepEqual(validateCase(def, { id }), [], `${id} is malformed`);
    const patchPath = join(CASES_DIR, id, "diff.patch");
    assert.ok(existsSync(patchPath), `${id} has no diff.patch`);
    assert.ok(
      filesFromPatch(readFileSync(patchPath, "utf8")).length > 0,
      `${id}: diff.patch touches no files, so it would be reviewed as an empty change`,
    );
  }
});

test("no case still carries the seeder's TODO placeholder", () => {
  // seed-from-history.mjs deliberately leaves `expect` unwritten — generating it from the commit
  // message would mean the case set was authored by the same kind of model it scores. This asserts
  // a human actually came back and wrote it.
  for (const id of readdirSync(CASES_DIR)) {
    const raw = readFileSync(join(CASES_DIR, id, "case.json"), "utf8");
    assert.ok(
      !raw.includes("TODO"),
      `${id}: still has the seeded TODO — write the expect block by hand`,
    );
  }
});

// --- detection rate: the sensitive half of the gate --------------------------------------------

// The shape the first real baseline produced: four must-find cases at 5 repeats, landing 2, 2, 2
// and 4 hits. Majority-of-5 calls three of them a miss, so RECALL reads 1/4 — which sounds like
// near-blindness, while the runs say the reviewer recognises these bugs half the time.
const runtimeCases = (hitsPerCase) =>
  hitsPerCase.map((hits) => ({
    specialist: "runtime",
    kind: "must-find",
    outcome: hits * 2 > 5 ? "hit" : "miss",
    hits,
    runs: 5,
  }));

test("summarizeEval: keeps the run-level detection rate the majority verdict throws away", () => {
  const summary = summarizeEval(runtimeCases([2, 2, 2, 4]));
  const runtime = summary.find((s) => s.id === "runtime");
  assert.deepEqual(runtime.mustFind, { hit: 1, total: 4, hits: 10, runs: 20 });
  assert.equal(detectionRate(runtime.mustFind), 0.5);
});

test("detectionRate: nothing run is null, never a zero that reads like a measurement", () => {
  assert.equal(detectionRate({ hits: 0, runs: 0 }), null);
  assert.equal(detectionRate({}), null);
  assert.equal(detectionRate({ hits: 0, runs: 5 }), 0);
});

test("summarizeEval: a must-not-find case counts the runs that emitted something, not the quiet ones", () => {
  const results = [
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "hit",
      hits: 5,
      runs: 5,
    },
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "miss",
      hits: 3,
      runs: 5,
    },
  ];
  const runtime = summarizeEval(results).find((s) => s.id === "runtime");
  // 0 noisy runs in the first case, 2 in the second.
  assert.deepEqual(runtime.mustNotFind, {
    fp: 1,
    total: 2,
    fpRuns: 2,
    runs: 10,
  });
});

test("rateTolerance: wide where the sample is thin, and it narrows as runs grow", () => {
  // The tolerance exists because the rate is a sample from a noisy process. At p≈0.5 over 20 runs
  // the standard error alone is ~0.11, so a strict "may not fall" would fail on sampling luck —
  // and a gate that flakes is a gate that gets disabled.
  const thin = rateTolerance({ hits: 10, runs: 20 });
  const thick = rateTolerance({ hits: 100, runs: 200 });
  assert.ok(thin > thick, "more runs must buy a tighter tolerance");
  assert.ok(thin > 0.2 && thin < 0.25);
  // A rate pinned at 0 or 1 has zero standard error; the floor stops that becoming a hair-trigger.
  assert.equal(rateTolerance({ hits: 0, runs: 40 }), 0.05);
  assert.equal(rateTolerance({ hits: 40, runs: 40 }), 0.05);
  // Nothing measured cannot regress.
  assert.equal(rateTolerance({ hits: 0, runs: 0 }), 1);
});

test("compareBaseline: a collapse RECALL cannot see is caught by the detection rate", () => {
  // This is the whole reason for the change. Every case slides 2/5 → 0/5: detection goes from 50%
  // to 10%, a total collapse — and `hit/total` does not move, because 2/5 and 0/5 are both "miss".
  const baseline = toBaseline(summarizeEval(runtimeCases([2, 2, 2, 4])), {
    repeats: 5,
    generatedAt: "t",
  });
  const collapsed = summarizeEval(runtimeCases([0, 0, 0, 2]));

  assert.equal(collapsed.find((s) => s.id === "runtime").mustFind.hit, 0);
  const cmp = compareBaseline(collapsed, baseline);
  assert.ok(!cmp.ok);
  assert.match(
    cmp.regressions.join(),
    /detection rate fell — 50% \(10\/20 runs\) → 10%/,
  );
});

test("compareBaseline: ordinary sampling noise is not a regression", () => {
  // 10/20 → 8/20 is well inside two standard errors. Flagging it would make the gate useless.
  const baseline = toBaseline(summarizeEval(runtimeCases([2, 2, 2, 4])), {
    repeats: 5,
    generatedAt: "t",
  });
  const jittered = summarizeEval(runtimeCases([1, 2, 2, 3]));
  assert.ok(compareBaseline(jittered, baseline).ok);
});

test("compareBaseline: a per-run false-positive rise is caught before it wins a case", () => {
  const quiet = summarizeEval([
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "hit",
      hits: 5,
      runs: 5,
    },
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "hit",
      hits: 5,
      runs: 5,
    },
  ]);
  const baseline = toBaseline(quiet, { repeats: 5, generatedAt: "t" });
  // Still a "hit" on both cases by majority, but now noisy on nearly half the runs.
  const noisier = summarizeEval([
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "hit",
      hits: 3,
      runs: 5,
    },
    {
      specialist: "runtime",
      kind: "must-not-find",
      outcome: "hit",
      hits: 3,
      runs: 5,
    },
  ]);
  assert.equal(noisier.find((s) => s.id === "runtime").mustNotFind.fp, 0);
  const cmp = compareBaseline(noisier, baseline);
  assert.ok(!cmp.ok);
  assert.match(
    cmp.regressions.join(),
    /per-run false-positive rate rose — 0% .* → 40%/,
  );
});

test("baselineLacksRates: an old baseline disables half the gate, and says so", () => {
  // A baseline written before this change has no hits/runs. Treating the missing fields as zero
  // would manufacture a regression on every run; treating the comparison as passed would report a
  // clean gate while half of it is switched off. It is detected and announced instead.
  const old = {
    generatedAt: "t",
    specialists: {
      runtime: {
        mustFind: { hit: 1, total: 4 },
        mustNotFind: { fp: 0, total: 2 },
      },
    },
  };
  assert.ok(baselineLacksRates(old));
  const cmp = compareBaseline(summarizeEval(runtimeCases([2, 2, 2, 4])), old);
  assert.ok(cmp.ok, "an old baseline must not manufacture a regression");
  assert.match(
    formatEval(summarizeEval(runtimeCases([2, 2, 2, 4])), {
      repeats: 5,
      baseline: old,
    }),
    /predates detection rates/,
  );

  const current = toBaseline(summarizeEval(runtimeCases([2, 2, 2, 4])), {
    repeats: 5,
    generatedAt: "t",
  });
  assert.ok(!baselineLacksRates(current));
  assert.ok(
    !formatEval(summarizeEval(runtimeCases([2, 2, 2, 4])), {
      repeats: 5,
      baseline: current,
    }).includes("predates detection rates"),
  );
});

test("formatEval: both resolutions are on the table, as numbers and a percentage", () => {
  const text = formatEval(summarizeEval(runtimeCases([2, 2, 2, 4])), {
    repeats: 5,
  });
  assert.match(text, /RECALL/);
  assert.match(text, /DETECTED/);
  assert.match(text, /1\/4/); // case level
  assert.match(text, /10\/20 50%/); // run level
});
