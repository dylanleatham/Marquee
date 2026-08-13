// Scoring a specialist against a frozen case, so a prompt edit can be shown not to have regressed.
//
// dev-harness §11 has asked for `review-agents/eval/` since the harness was designed, and until now
// it did not exist — so every edit to a specialist's system-prompt, examples or config shipped
// unvalidated. The prompt-ordering fix in RA-4 was a good change; we know that from reasoning about
// it, not from measuring it. Design: docs/specs/harness-self-improvement.md §4.2.
//
// This module is the pure half — schema, matching, scoring, cache keys, baseline comparison — so
// all of it is unit-tested without a Claude session. `eval/run.mjs` is the CLI that spends tokens.
//
// The outcome vocabulary carries one distinction the obvious two-value version would lose:
//
//   hit            the specialist was triggered, ran, and said the thing the case expects
//   miss           it was triggered and ran, and did not
//   not-triggered  its routing globs never selected these files, so it could not have
//   not-installed  no such specialist on disk (a case written ahead of its reviewer)
//
// `not-triggered` is the RA-5 failure (issue #192) in measurable form: a reviewer that is never
// selected produces no findings and no `[GAP]` warning, so the run reads as a clean pass. Folding
// it into `miss` would hide the difference between a reviewer that looked and a reviewer that was
// never asked, which is the exact confusion that let a blocking specialist sit out a review for
// weeks.

import { createHash } from "node:crypto";

export const KINDS = ["must-find", "must-not-find"];
export const OUTCOMES = ["hit", "miss", "not-triggered", "not-installed"];

/**
 * Problems with a case definition, as a list of human-readable strings. Empty means valid.
 *
 * A malformed case must fail loudly at load rather than quietly scoring zero — a case that cannot
 * be evaluated is not a case the reviewer passed.
 */
export function validateCase(def, { id } = {}) {
  const problems = [];
  const at = id ?? def?.id ?? "(unknown)";
  if (!def || typeof def !== "object")
    return [`${at}: case.json is not an object`];
  if (!def.id) problems.push(`${at}: missing "id"`);
  else if (id && def.id !== id)
    problems.push(`${at}: "id" is "${def.id}" but the directory is "${id}"`);
  if (!KINDS.includes(def.kind))
    problems.push(`${at}: "kind" must be one of ${KINDS.join(" | ")}`);
  if (!def.specialist || typeof def.specialist !== "string")
    problems.push(`${at}: missing "specialist"`);
  if (def.kind === "must-find") {
    if (!def.expect || typeof def.expect !== "object")
      problems.push(`${at}: a must-find case needs an "expect" object`);
    else if (!def.expect.file && !def.expect.matches?.length)
      problems.push(
        `${at}: "expect" needs at least a "file" or a "matches" pattern — otherwise any finding at ` +
          `all would count as a hit, and the case would pass without measuring anything`,
      );
  }
  for (const pattern of [
    ...(def.expect?.matches ?? []),
    ...(def.forbid ?? []),
  ]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      problems.push(`${at}: "${pattern}" is not a valid regular expression`);
    }
  }
  return problems;
}

/**
 * Repo-relative paths a unified diff touches.
 *
 * Reads the `diff --git a/X b/Y` header as well as the `+++` line, because neither alone is enough:
 * a **reversed** diff (`git show -R`, how must-find cases are built) writes `+++ a/path`, not
 * `+++ b/path`, and a section that only deletes a file writes `+++ /dev/null` and names the path
 * nowhere else. Stripping only `b/` produced paths like `a/docs/specs/x.md`, which then matched no
 * exclusion glob — so `--exclude` silently kept everything, including the test files whose names
 * hand the reviewer the answer.
 */
export function filesFromPatch(patch) {
  const files = new Set();
  const strip = (p) => String(p).replace(/^[ab]\//, "");
  for (const line of String(patch ?? "").split("\n")) {
    const header = /^diff --git (\S+) (\S+)\s*$/.exec(line);
    if (header) {
      for (const p of [header[1], header[2]]) {
        const rel = strip(p);
        if (rel !== "/dev/null") files.add(rel);
      }
      continue;
    }
    const plus = /^\+\+\+ (\S+)/.exec(line);
    if (plus && plus[1] !== "/dev/null") files.add(strip(plus[1]));
  }
  return [...files];
}

/** Do two paths name the same file? Lenient at the front: models often reply with a partial path. */
const samePath = (a, b) => {
  const x = String(a ?? "").replace(/\\/g, "/");
  const y = String(b ?? "").replace(/\\/g, "/");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

/**
 * Does one finding satisfy a case's `expect` block?
 *
 * `expect.file` may be a list, because a diff usually has more than one place the same bug is
 * visible from and the reviewer picks one. The first real eval run scored a false miss for exactly
 * this: `runtime` found the rename-over-a-served-file race and reported it at
 * `media/video.ts:266`, while the case pinned `albums/actions.ts` — both true, one scored wrong. A
 * baseline built from that would have recorded a recall gap that does not exist, and the gate would
 * then have been protecting the wrong number.
 */
export function matchesExpect(finding, expect = {}) {
  if (expect.file) {
    const allowed = Array.isArray(expect.file) ? expect.file : [expect.file];
    if (!allowed.some((p) => samePath(finding.file, p))) return false;
  }
  if (expect.severity && finding.severity !== expect.severity) return false;
  if (expect.matches?.length) {
    const text = `${finding.message ?? ""} ${finding.suggestion ?? ""}`;
    if (!expect.matches.some((p) => new RegExp(p, "i").test(text)))
      return false;
  }
  return true;
}

/**
 * Score one execution of one case.
 *
 * For `must-not-find`, a false positive is a **blocking** finding, or any finding matching an
 * explicit `forbid` pattern. Counting every info finding would make the metric unusable: a reviewer
 * noticing something true-but-minor on a clean diff is doing its job, while a blocking finding on a
 * clean diff is what stops a push and teaches someone to reach for `--no-verify`.
 */
export function scoreCase(def, findings) {
  if (def.kind === "must-find") {
    const found = (findings ?? []).find((f) => matchesExpect(f, def.expect));
    return found
      ? { outcome: "hit", finding: found }
      : { outcome: "miss", finding: null };
  }
  const offender = (findings ?? []).find(
    (f) =>
      f.severity === "blocking" ||
      (def.forbid?.length &&
        def.forbid.some((p) =>
          new RegExp(p, "i").test(`${f.message ?? ""} ${f.suggestion ?? ""}`),
        )),
  );
  // For a must-not-find case, "hit" means the case passed: the reviewer stayed quiet.
  return offender
    ? { outcome: "miss", finding: offender }
    : { outcome: "hit", finding: null };
}

/**
 * Collapse N executions of one case into one outcome.
 *
 * A model's reply varies run to run, so a single execution is not a measurement and a gate built on
 * one would flake — and a gate that flakes gets disabled. Majority of the *scored* runs; a case
 * whose specialist was never triggered or never installed reports that instead, since repeating it
 * cannot change the answer.
 */
export function majorityOutcome(outcomes) {
  if (!outcomes.length) return { outcome: "miss", hits: 0, runs: 0 };
  const structural = outcomes.find(
    (o) => o === "not-triggered" || o === "not-installed",
  );
  if (structural)
    return { outcome: structural, hits: 0, runs: outcomes.length };
  const hits = outcomes.filter((o) => o === "hit").length;
  return {
    outcome: hits * 2 > outcomes.length ? "hit" : "miss",
    hits,
    runs: outcomes.length,
  };
}

/**
 * Identity of "this case, judged by this exact reviewer".
 *
 * Everything that can change the answer goes in: the case, the diff, and the specialist's prompt,
 * examples, config and model. Change any of them and the cached result is void; change something
 * unrelated and it stands, which is what makes re-running the suite after a one-reviewer edit cheap
 * enough to actually do.
 */
export function cacheKey({ caseJson, patch, specialist, repeats }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        caseJson,
        patch,
        repeats,
        systemPrompt: specialist?.systemPrompt ?? "",
        examples: specialist?.examples ?? "",
        model: specialist?.model ?? "",
        config: {
          blocking: !!specialist?.blocking,
          triggerAll: !!specialist?.triggerAll,
          triggerGlobs: specialist?.triggerGlobs ?? [],
          triggerImports: specialist?.triggerImports ?? [],
          contextGlobs: specialist?.contextGlobs ?? [],
          includePackageSpecs: !!specialist?.includePackageSpecs,
        },
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * When may the result cache be read, and when written?
 *
 * A **mock** run neither reads nor writes it. `REVIEW_MOCK=1` returns a canned `[]` for every
 * specialist, so its results are pipeline smoke rather than measurements — and `cacheKey` cannot
 * tell the two apart, because mock-ness is a property of the environment, not of the case or the
 * reviewer. Found by doing it: a mock run seeded the cache, and the next *real* run read its zeroes
 * back and printed `miss [cached]` without spending a session. A cached nothing served as a
 * measurement is the failure this whole module exists to prevent (dev-harness §11).
 *
 * `--no-cache` only suppresses the *read*; a freshly computed real result is still worth keeping.
 */
export function cachePolicy({ mock = false, noCache = false } = {}) {
  return { read: !mock && !noCache, write: !mock };
}

/** Per-specialist recall and false positives, from scored case results. */
export function summarizeEval(results) {
  const bySpecialist = new Map();
  for (const r of results) {
    const entry = bySpecialist.get(r.specialist) ?? {
      id: r.specialist,
      mustFind: { hit: 0, total: 0 },
      mustNotFind: { fp: 0, total: 0 },
      notTriggered: 0,
      notInstalled: 0,
    };
    if (r.kind === "must-find") {
      entry.mustFind.total++;
      if (r.outcome === "hit") entry.mustFind.hit++;
    } else {
      entry.mustNotFind.total++;
      if (r.outcome === "miss") entry.mustNotFind.fp++;
    }
    if (r.outcome === "not-triggered") entry.notTriggered++;
    if (r.outcome === "not-installed") entry.notInstalled++;
    bySpecialist.set(r.specialist, entry);
  }
  return [...bySpecialist.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The comparable shape written to `eval/baseline.json`. */
export function toBaseline(summary, { repeats, generatedAt }) {
  return {
    generatedAt,
    repeats,
    specialists: Object.fromEntries(
      summary.map((s) => [
        s.id,
        { mustFind: { ...s.mustFind }, mustNotFind: { ...s.mustNotFind } },
      ]),
    ),
  };
}

/**
 * Is this run at least as good as the recorded baseline?
 *
 * Two ways to fail, and a third that is easy to miss: a specialist the baseline covered that this
 * run does not cover at all. Deleting a case is the cheapest possible way to make a gate go green,
 * so a shrinking suite has to register as a regression rather than as an improvement.
 */
export function compareBaseline(summary, baseline) {
  if (!baseline?.specialists)
    return { ok: false, reason: "no-baseline", regressions: [] };
  const current = new Map(summary.map((s) => [s.id, s]));
  const regressions = [];
  for (const [id, was] of Object.entries(baseline.specialists)) {
    const now = current.get(id);
    if (!now) {
      regressions.push(
        `${id}: the baseline covers it with ${was.mustFind.total} must-find case(s), this run scored none`,
      );
      continue;
    }
    if (now.mustFind.hit < was.mustFind.hit)
      regressions.push(
        `${id}: recall fell — ${was.mustFind.hit}/${was.mustFind.total} → ${now.mustFind.hit}/${now.mustFind.total}`,
      );
    if (now.mustNotFind.fp > was.mustNotFind.fp)
      regressions.push(
        `${id}: false positives rose — ${was.mustNotFind.fp}/${was.mustNotFind.total} → ${now.mustNotFind.fp}/${now.mustNotFind.total}`,
      );
  }
  return { ok: regressions.length === 0, reason: null, regressions };
}

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

/** Plain-text report. Nothing is encoded in colour; every column reads as a word or a number. */
export function formatEval(summary, { repeats, baseline } = {}) {
  const out = [
    `review-agents eval: ${summary.reduce((n, s) => n + s.mustFind.total + s.mustNotFind.total, 0)} case(s), ${repeats} run(s) each.`,
    "",
    [
      pad("SPECIALIST", 18),
      padStart("RECALL", 8),
      padStart("FALSE-POS", 11),
      padStart("NOT-TRIG", 10),
      padStart("MISSING", 9),
    ].join(""),
  ];
  for (const s of summary) {
    out.push(
      [
        pad(s.id, 18),
        padStart(`${s.mustFind.hit}/${s.mustFind.total}`, 8),
        padStart(`${s.mustNotFind.fp}/${s.mustNotFind.total}`, 11),
        padStart(s.notTriggered || "—", 10),
        padStart(s.notInstalled || "—", 9),
      ].join(""),
    );
  }
  out.push(
    "",
    "RECALL is must-find cases the specialist actually flagged. FALSE-POS is must-not-find cases",
    "where it emitted a blocking finding (or matched the case's `forbid`). NOT-TRIG is cases its",
    "routing globs never selected — it could not have found them, which is a routing bug, not a",
    "prompt one (issue #192). MISSING is cases whose specialist is not installed yet.",
  );
  if (baseline) {
    const cmp = compareBaseline(summary, baseline);
    out.push("");
    if (cmp.ok) out.push(`Baseline (${baseline.generatedAt}): no regression.`);
    else {
      out.push(`Baseline (${baseline.generatedAt}): REGRESSED`);
      for (const r of cmp.regressions) out.push(`  - ${r}`);
    }
  }
  return out.join("\n");
}
