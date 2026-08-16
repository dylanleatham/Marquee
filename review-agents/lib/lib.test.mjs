import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globToRegExp, matchesAny, mapWithConcurrency } from "./util.mjs";
import {
  extractJsonArray,
  salvageProse,
  normalizeFindings,
  dedupe,
  parseWithRepair,
} from "./findings.mjs";
import {
  resolveTimeoutMs,
  resolveRepairTimeoutMs,
  resolveRetries,
  resolveConcurrency,
  runSpecialist,
  spawnOnce,
} from "./claude.mjs";
import { summarizeRun, silentWarning } from "./outcome.mjs";
import { composePrompt, repairPrompt } from "./prompt.mjs";
import { loadSpecialists, buildContext, specsFor } from "./specialists.mjs";

test("globToRegExp: ** spans directories, * does not", () => {
  assert.match(
    "packages/contracts/schemas/x.json",
    globToRegExp("packages/contracts/**"),
  );
  assert.match(
    "packages/curator/src/deep/a.ts",
    globToRegExp("packages/*/src/**"),
  );
  assert.doesNotMatch(
    "packages/curator/test/a.ts",
    globToRegExp("packages/*/src/**"),
  );
  assert.doesNotMatch("packages/a/b/c.ts", globToRegExp("packages/*/c.ts"));
  assert.match("packages/a/c.ts", globToRegExp("packages/*/c.ts"));

  // The #192 distinction: a nested source root (Curator's UI) is only reachable with `**`.
  assert.doesNotMatch(
    "packages/curator/ui/src/App.tsx",
    globToRegExp("packages/*/src/**"),
  );
  assert.match(
    "packages/curator/ui/src/App.tsx",
    globToRegExp("packages/**/src/**"),
  );
  assert.match(
    "packages/curator/src/index.ts",
    globToRegExp("packages/**/src/**"),
  );
});

test("matchesAny: true when any pattern matches", () => {
  assert.equal(
    matchesAny("packages/contracts/schemas/a.json", ["packages/contracts/**"]),
    true,
  );
  assert.equal(matchesAny("README.md", ["packages/**"]), false);
});

// --- issue #192: routing must cover every source root that actually exists ---

const AGENTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(AGENTS_DIR);

/** Every `src` directory under `packages/`, discovered from disk rather than hard-coded. */
function sourceRoots() {
  const out = [];
  const walk = (rel) => {
    const abs = join(REPO_ROOT, rel);
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo")
        continue;
      const childRel = `${rel}/${entry}`;
      if (!statSync(join(REPO_ROOT, childRel)).isDirectory()) continue;
      if (entry === "src") out.push(childRel);
      else walk(childRel);
    }
  };
  walk("packages");
  return out;
}

function specialistConfig(id) {
  return JSON.parse(readFileSync(join(AGENTS_DIR, id, "config.json"), "utf8"));
}

// These reviewers claim to cover all first-party source. `test-auditor` in particular is what
// CLAUDE.md's "new surface ⇒ test in the same change" gate leans on, so a source root it cannot
// see is a silent hole in that gate — which is exactly what `packages/*/src/**` was: one level
// deep, so all of Curator's React UI under `packages/curator/ui/src/` went unreviewed.
for (const id of ["test-auditor", "spec-adherence"]) {
  test(`${id} triggers on every packages/**/src root on disk (#192)`, () => {
    const { triggerGlobs } = specialistConfig(id);
    const missed = sourceRoots().filter(
      (root) => !matchesAny(`${root}/Thing.tsx`, triggerGlobs),
    );
    assert.deepEqual(
      missed,
      [],
      `${id} would not run on changes under: ${missed.join(", ")}`,
    );
  });
}

// --- issue #327: first-party source is not only under packages/ ------------------------------

/**
 * Every tracked first-party source file outside `packages/`, discovered from git rather than listed.
 *
 * `review-agents/`, `scripts/` and `contract-tests/` are as much this project's code as `packages/`
 * is — `review-agents/lib` alone exports 95 symbols — and a reviewer that claims to cover
 * first-party source and cannot see them is claiming something untrue.
 */
function nonPackageSource() {
  return execFileSync(
    "git",
    ["ls-files", "review-agents", "scripts", "contract-tests"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
    },
  )
    .split("\n")
    .filter((f) => /\.(mjs|cjs|js|ts|tsx)$/.test(f) && !/\.test\./.test(f));
}

test("test-auditor triggers on first-party source outside packages/ (#327)", () => {
  // The blind spot this closes: test-auditor is what CLAUDE.md's "new surface ⇒ test in the same
  // change" rule names as its enforcer, and it could not see the harness's own code. A reviewer
  // that is never *triggered* emits no findings and no [GAP] warning, so the run prints
  // "No findings 🎵" — RA-5 (#192) in a different tree.
  const { triggerGlobs } = specialistConfig("test-auditor");
  const source = nonPackageSource();
  assert.ok(source.length > 10, "there is real source outside packages/");
  const missed = source.filter((f) => !matchesAny(f, triggerGlobs));
  assert.deepEqual(
    missed,
    [],
    `test-auditor would not run on ${missed.length} first-party source file(s): ${missed.slice(0, 5).join(", ")}`,
  );
});

test("test-auditor still ignores what is not source", () => {
  // Widening a trigger surface is only safe if it stays a surface. A reviewer that fires on every
  // fixture and lockfile is a reviewer whose findings get skimmed.
  const { triggerGlobs } = specialistConfig("test-auditor");
  for (const notSource of [
    "fixtures/covers/weezer-blue.jpg",
    "review-agents/README.md",
    "docs/specs/curator-spec.md",
    "pnpm-lock.yaml",
    "packages/curator/test/media.test.ts",
  ]) {
    assert.equal(
      matchesAny(notSource, triggerGlobs),
      false,
      `${notSource} is not new production surface`,
    );
  }
});

// --- issue #327, second half: spec-adherence over the harness's own code ----------------------

test("spec-adherence triggers on first-party source outside packages/ (#327)", () => {
  // Same blind spot test-auditor had. Held back from the first fix because triggering alone would
  // have been worse than not triggering: a reviewer asked to check code against a spec it was never
  // given produces confident nonsense.
  const { triggerGlobs } = specialistConfig("spec-adherence");
  const source = nonPackageSource();
  assert.ok(source.length > 10, "there is real source outside packages/");
  const missed = source.filter((f) => !matchesAny(f, triggerGlobs));
  assert.deepEqual(
    missed,
    [],
    `spec-adherence would not run on: ${missed.slice(0, 5).join(", ")}`,
  );
});

test("specsFor: the harness's own code has specs, and they are loaded", () => {
  // The half that makes the trigger worth having. `review-agents/` is specified by dev-harness §6;
  // without this mapping the reviewer gets the diff and nothing to check it against.
  assert.deepEqual(specsFor(["review-agents/lib/findings.mjs"]), [
    "docs/specs/dev-harness.md",
  ]);
  assert.deepEqual(specsFor(["scripts/check-adr-numbers.mjs"]), [
    "docs/specs/dev-harness.md",
  ]);
  assert.deepEqual(specsFor(["contract-tests/schemas.test.mjs"]).sort(), [
    "docs/specs/integration-contract.md",
    "docs/specs/testing-strategy.md",
  ]);
});

test("specsFor: packages still map by package name, unchanged", () => {
  assert.deepEqual(specsFor(["packages/curator/src/server.ts"]).sort(), [
    "docs/specs/album-onboarding-workflow.md",
    "docs/specs/curator-spec.md",
    "docs/specs/roadie-spec.md",
  ]);
  assert.deepEqual(specsFor(["packages/backdrop/src/x.ts"]), [
    "docs/specs/backdrop-spec.md",
  ]);
  assert.deepEqual(specsFor(["README.md"]), []);
});

test("spec-adherence reviewing harness code is handed dev-harness.md", () => {
  // End to end through the real buildContext, because the mapping is only useful if it survives
  // the trip into the prompt.
  const spec = loadSpecialists().find((s) => s.id === "spec-adherence");
  const context = buildContext(spec, {
    files: ["review-agents/lib/findings.mjs"],
    diff: "+export function fingerprint(specialist, message) {}",
  });
  assert.match(context, /# Context: docs\/specs\/dev-harness\.md/);
});

test("every specialist directory has the three files the README documents", () => {
  for (const dir of readdirSync(AGENTS_DIR)) {
    const cfgPath = join(AGENTS_DIR, dir, "config.json");
    if (!existsSync(cfgPath)) continue;
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(config.id, dir, `${dir}/config.json id must match its dir`);
    // Routing is opt-in per specialist; one of these must be present or it never runs at all.
    assert.ok(
      config.triggerAll ||
        config.triggerGlobs?.length ||
        config.triggerImports?.length,
      `${dir} declares no trigger, so it can never run`,
    );
    assert.ok(
      existsSync(join(AGENTS_DIR, dir, "system-prompt.md")),
      `${dir} has no system-prompt.md`,
    );
  }
});

test("extractJsonArray: handles fenced, bare, and absent arrays", () => {
  assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('here are findings: [{"a":2}] done'), [
    { a: 2 },
  ]);
  assert.deepEqual(extractJsonArray("[]"), []);
  assert.equal(extractJsonArray("no json here"), null);
});

test("extractJsonArray: ignores stray string arrays in prose, finds the object array", () => {
  // Regression: a specialist quoting code like headers["x"] used to break the naive slice.
  const reply =
    'I checked req.headers["x-trigger-secret"] and found: [{"severity":"info","message":"m"}]';
  assert.deepEqual(extractJsonArray(reply), [
    { severity: "info", message: "m" },
  ]);
  // Pure prose whose only brackets are a string array is treated as "no findings array".
  assert.equal(extractJsonArray('looked at obj["key"], all good'), null);
});

test("extractJsonArray: recovers a lone finding object emitted without the array wrapper", () => {
  // Regression (RA-1): the runtime specialist intermittently returns a single finding as a
  // bare object — mirroring the single-object template it was shown — instead of wrapping it
  // in an array. That used to parse as null and the whole specialist's review was dropped.
  assert.deepEqual(
    extractJsonArray(
      '{"severity":"blocking","file":"a.ts","line":3,"message":"fetch has no timeout"}',
    ),
    [
      {
        severity: "blocking",
        file: "a.ts",
        line: 3,
        message: "fetch has no timeout",
      },
    ],
  );
  // Same shape inside a ```json fence.
  assert.deepEqual(
    extractJsonArray('```json\n{"severity":"info","message":"leak"}\n```'),
    [{ severity: "info", message: "leak" }],
  );
});

test("extractJsonArray: recovers multiple lone finding objects (one per line)", () => {
  // Regression (RA-1): sonnet occasionally emits one object per finding with no array,
  // echoing the two separate examples it was given.
  const reply =
    '{"severity":"blocking","file":"a.ts","message":"m1"}\n{"severity":"info","file":"b.ts","message":"m2"}';
  assert.deepEqual(extractJsonArray(reply), [
    { severity: "blocking", file: "a.ts", message: "m1" },
    { severity: "info", file: "b.ts", message: "m2" },
  ]);
});

test("extractJsonArray: incidental JSON-ish prose objects are not findings", () => {
  // A bare object with no `message` isn't a finding; such prose must still yield null so a
  // genuine parse failure stays visible instead of becoming a phantom finding.
  assert.equal(
    extractJsonArray('config was {"retries": 3, "timeout": null}'),
    null,
  );
});

test("salvageProse: surfaces a prose-only reply as one info finding (RA-1)", () => {
  // The exact shape that dropped silently on 2026-07-13: test-auditor described the Roadie
  // downloadArt gap in a paragraph, not a JSON array. extractJsonArray can't recover it...
  const prose =
    "One blocking gap: `downloadArt`'s failure paths (missing `spotifyArtUrl` and a " +
    "`SpotifyError` during art download) are never exercised — every Spotify test uses a stub " +
    "that always succeeds.";
  assert.equal(extractJsonArray(prose), null);

  // ...so salvageProse turns it into a single info finding carrying the prose.
  const salvaged = salvageProse(prose);
  assert.equal(salvaged.length, 1);
  assert.equal(salvaged[0].severity, "info");
  assert.equal(salvaged[0].file, "(unparsed)");
  assert.match(salvaged[0].message, /review manually/);
  assert.match(salvaged[0].message, /downloadArt/);

  // Blank / trivial / fence-only replies stay null — no phantom finding.
  assert.equal(salvageProse(""), null);
  assert.equal(salvageProse("   \n  "), null);
  assert.equal(salvageProse("```json\n```"), null);
  assert.equal(salvageProse("ok"), null);
});

test("salvageProse: collapses whitespace and truncates long prose", () => {
  const long = "word ".repeat(400); // ~2000 chars
  const [f] = salvageProse(long);
  assert.ok(f.message.length < 700); // truncated with an ellipsis marker
  assert.match(f.message, /\[…\]$/);
  assert.doesNotMatch(f.message, /\n/); // single line
});

test("resolveRetries: default 1, env override, fallback on bad input", () => {
  assert.equal(resolveRetries({}), 1);
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "" }), 1);
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "0" }), 0); // explicit disable
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "2" }), 2);
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "nope" }), 1);
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "-1" }), 1);
  assert.equal(resolveRetries({ REVIEW_TIMEOUT_RETRIES: "1.5" }), 1);
});

test("runSpecialist: retries once on a timeout, then succeeds (RA-2)", async () => {
  let calls = 0;
  const spawn = async () => {
    calls++;
    // First attempt times out; second returns a clean JSON reply.
    if (calls === 1)
      return { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) };
    return { status: 0, stdout: '{"result":"[]"}' };
  };
  const res = await runSpecialist({ prompt: "p" }, { spawn, retries: 1 });
  assert.equal(calls, 2);
  assert.equal(res.ok, true);
  assert.equal(res.text, "[]");
});

test("runSpecialist: gives up after retries are exhausted on repeated timeouts", async () => {
  let calls = 0;
  const spawn = async () => {
    calls++;
    return { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) };
  };
  const res = await runSpecialist({ prompt: "p" }, { spawn, retries: 1 });
  assert.equal(calls, 2); // initial + 1 retry
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
});

test("runSpecialist: does NOT retry a non-timeout failure", async () => {
  let calls = 0;
  const spawn = async () => {
    calls++;
    return { status: 1, stderr: "boom" };
  };
  const res = await runSpecialist({ prompt: "p" }, { spawn, retries: 3 });
  assert.equal(calls, 1); // a real failure isn't retried
  assert.equal(res.ok, false);
  assert.match(res.reason, /exited 1/);
});

test("normalizeFindings: drops malformed, tags specialist, respects blocking", () => {
  const raw = [
    { severity: "blocking", file: "a.ts", line: 3, message: "bad" },
    { severity: "info", message: "note" },
    { line: 9 }, // no message -> dropped
  ];
  const blocking = normalizeFindings(raw, { specialist: "x", blocking: true });
  assert.equal(blocking.length, 2);
  assert.equal(blocking[0].severity, "blocking");
  assert.equal(blocking[0].specialist, "x");
  assert.equal(blocking[1].severity, "info");

  // A non-blocking specialist can never produce a blocking finding.
  const info = normalizeFindings(raw, { specialist: "y", blocking: false });
  assert.ok(info.every((f) => f.severity === "info"));
});

test("resolveTimeoutMs: env override, with fallback to default on bad input", () => {
  const DEFAULT = 90_000;
  // Missing / empty -> default.
  assert.equal(resolveTimeoutMs({}), DEFAULT);
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "" }), DEFAULT);
  // Valid positive integer -> honored.
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "180000" }), 180_000);
  // Garbage / non-positive / non-integer -> default, never throws.
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "nope" }), DEFAULT);
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "0" }), DEFAULT);
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "-5" }), DEFAULT);
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "1.5" }), DEFAULT);
});

test("resolveTimeoutMs: a specialist's own timeoutMs wins over the env default (RA-3)", () => {
  const DEFAULT = 90_000;
  // The whole point: `runtime` needs minutes while `security` finishes in seconds, so the budget
  // belongs to the specialist, not the machine.
  assert.equal(resolveTimeoutMs({}, { timeoutMs: 300_000 }), 300_000);
  assert.equal(
    resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "90000" }, { timeoutMs: 300_000 }),
    300_000,
  );
  // No per-specialist value -> the env default still applies.
  assert.equal(resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "120000" }, {}), 120_000);
  // Bad per-specialist value falls through instead of throwing or zeroing the budget.
  assert.equal(resolveTimeoutMs({}, { timeoutMs: "nope" }), DEFAULT);
  assert.equal(resolveTimeoutMs({}, { timeoutMs: 0 }), DEFAULT);
  assert.equal(resolveTimeoutMs({}, { timeoutMs: -1 }), DEFAULT);
  assert.equal(
    resolveTimeoutMs({ REVIEW_TIMEOUT_MS: "120000" }, { timeoutMs: null }),
    120_000,
  );
});

test("runSpecialist: passes the specialist's budget through to spawn (RA-3)", async () => {
  let seen;
  const spawn = async (_bin, _args, o) => {
    seen = o.timeout;
    return { status: 0, stdout: '{"result":"[]"}' };
  };
  await runSpecialist(
    { prompt: "p", timeoutMs: 300_000 },
    { spawn, retries: 0 },
  );
  assert.equal(seen, 300_000);
  await runSpecialist({ prompt: "p" }, { spawn, retries: 0 });
  assert.equal(seen, 90_000); // no declared budget -> the default
});

// --- RA-3 / issue #116: "did not run" must never be reported as "found nothing" ---

test("summarizeRun: a clean review is clean", () => {
  const runs = [
    { id: "security", blocking: true, status: "no-findings" },
    { id: "consistency", blocking: false, status: "no-findings" },
  ];
  const out = summarizeRun(runs, []);
  assert.deepEqual(out.silent, []);
  assert.equal(out.clean, true);
});

test("summarizeRun: an unavailable blocking specialist makes the run not clean", () => {
  const runs = [
    { id: "security", blocking: true, status: "no-findings" },
    {
      id: "runtime",
      blocking: true,
      status: "unavailable",
      reason: "spawnSync claude ETIMEDOUT",
    },
  ];
  const out = summarizeRun(runs, []);
  // No findings at all, yet the run must not read as a pass — this is the RA-3 bug.
  assert.equal(out.blocking.length, 0);
  assert.equal(out.clean, false);
  assert.deepEqual(
    out.silent.map((s) => s.id),
    ["runtime"],
  );
  assert.match(out.silent[0].reason, /ETIMEDOUT/);
});

test("summarizeRun: an unparseable blocking reply counts as no verdict too", () => {
  // `error` = the reply couldn't be parsed *and* couldn't be salvaged as prose. Same class as a
  // timeout: the dimension went unreviewed.
  const out = summarizeRun(
    [{ id: "runtime", blocking: true, status: "error" }],
    [],
  );
  assert.equal(out.clean, false);
});

test("summarizeRun: a salvaged prose reply is a verdict, not a gap", () => {
  // RA-1 surfaces prose as an info finding — the specialist did review the diff, so it isn't silent.
  const out = summarizeRun(
    [{ id: "consistency", blocking: true, status: "unformatted" }],
    [{ severity: "info", message: "…", specialist: "consistency" }],
  );
  assert.deepEqual(out.silent, []);
  assert.equal(out.clean, true);
});

test("summarizeRun: a non-blocking specialist going missing doesn't gate", () => {
  const out = summarizeRun(
    [{ id: "consistency", blocking: false, status: "unavailable" }],
    [],
  );
  assert.deepEqual(out.silent, []);
  assert.equal(out.clean, true);
});

test("summarizeRun: blocking findings still gate, independently of gaps", () => {
  const out = summarizeRun(
    [{ id: "security", blocking: true, status: "ran" }],
    [{ severity: "blocking", message: "leak", specialist: "security" }],
  );
  assert.equal(out.blocking.length, 1);
  assert.equal(out.clean, false);
});

test("silentWarning: names the specialists and says the run is incomplete", () => {
  const msg = silentWarning([
    { id: "runtime", status: "unavailable" },
    { id: "spec-adherence", status: "unavailable" },
  ]);
  assert.match(msg, /runtime, spec-adherence/);
  assert.match(msg, /incomplete, not as a pass/);
  assert.match(msg, /timeoutMs/); // tells you how to fix it
  assert.equal(silentWarning([]), "");
});

test("dedupe: collapses same file+line+message, prefers blocking", () => {
  const out = dedupe([
    { file: "a.ts", line: 1, message: "m", severity: "info", specialist: "a" },
    {
      file: "a.ts",
      line: 1,
      message: "m",
      severity: "blocking",
      specialist: "b",
    },
    { file: "a.ts", line: 2, message: "m", severity: "info", specialist: "a" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out.find((f) => f.line === 1).severity, "blocking");
});

// --- RA-4 / issue #117: one reformat round before structure is lost to prose salvage ---

const PROSE =
  "I found one blocking issue: the upload handler has no timeout, so a stalled client wedges " +
  "the event loop. Wrap the read in AbortSignal.timeout(5000).";

test("parseWithRepair: a well-formed reply is used as-is, with no repair call", async () => {
  let called = 0;
  const out = await parseWithRepair('[{"severity":"info","message":"m"}]', {
    repair: () => {
      called++;
      return { ok: true, text: "[]" };
    },
  });
  assert.equal(out.outcome, "clean");
  assert.equal(called, 0); // never spend a second call on a reply that already parsed
  assert.equal(out.raw.length, 1);
});

test("parseWithRepair: prose is recovered as structured findings, keeping severity", async () => {
  const out = await parseWithRepair(PROSE, {
    repair: (text) => {
      // The repair is a translation, so it must be handed the original reply.
      assert.match(text, /wedges the event loop/);
      return {
        ok: true,
        text: '[{"severity":"blocking","file":"a.ts","line":4,"message":"no timeout"}]',
      };
    },
  });
  assert.equal(out.outcome, "repaired");
  // The point of the whole fix: a blocking finding written in prose can now actually block, and
  // arrives with a file and line instead of collapsed into one unstructured info item.
  assert.equal(out.raw[0].severity, "blocking");
  assert.equal(out.raw[0].file, "a.ts");
  assert.equal(out.raw[0].line, 4);
});

test("parseWithRepair: a repair that also replies in prose falls through, it doesn't loop", async () => {
  let calls = 0;
  const out = await parseWithRepair(PROSE, {
    repair: () => {
      calls++;
      return { ok: true, text: "Sorry — here is the summary again in words." };
    },
  });
  assert.equal(calls, 1); // exactly one extra attempt, never a retry storm
  assert.equal(out.outcome, "unrepaired");
  assert.equal(out.raw, null);
});

test("parseWithRepair: a failed or throwing repair is never worse than not trying", async () => {
  assert.deepEqual(
    await parseWithRepair(PROSE, {
      repair: () => ({ ok: false, reason: "timeout" }),
    }),
    { raw: null, outcome: "unrepaired" },
  );
  assert.deepEqual(
    await parseWithRepair(PROSE, {
      repair: () => {
        throw new Error("spawn failed");
      },
    }),
    { raw: null, outcome: "unrepaired" },
  );
  // No repair injected at all (the mock path) still degrades to prose salvage.
  assert.deepEqual(await parseWithRepair(PROSE), {
    raw: null,
    outcome: "unrepaired",
  });
});

test("parseWithRepair: an empty findings array is a clean answer, not something to repair", async () => {
  let called = 0;
  const out = await parseWithRepair("[]", {
    repair: () => {
      called++;
      return { ok: true, text: "[]" };
    },
  });
  assert.equal(out.outcome, "clean");
  assert.deepEqual(out.raw, []);
  assert.equal(called, 0);
});

test("composePrompt: the output contract comes after the diff, not before it (RA-4)", () => {
  const prompt = composePrompt(
    { systemPrompt: "You are the runtime reviewer.", examples: "" },
    "diff --git a/x.ts b/x.ts\n+const x = 1;",
  );
  const diffAt = prompt.indexOf("diff --git");
  const contractAt = prompt.indexOf("# Output contract");
  assert.ok(diffAt !== -1 && contractAt !== -1);
  // This ordering *is* the fix: with the contract first, a large diff put thousands of tokens
  // between "reply with JSON only" and the moment of replying, and specialists drifted into prose.
  assert.ok(
    contractAt > diffAt,
    "the contract must sit closest to generation, after the review context",
  );
  // The role still leads — the specialist needs to know who it is before it reads the diff.
  assert.ok(prompt.indexOf("runtime reviewer") < diffAt);
});

test("composePrompt: the contract shows the empty answer, which is the common case", () => {
  const prompt = composePrompt({ systemPrompt: "x" }, "diff");
  assert.match(prompt, /Respond with exactly:\n\[\]/);
  // A worked example of a real array, so "nothing to report" isn't the only shape it has seen.
  assert.match(prompt, /"severity": "blocking"/);
});

test("repairPrompt: asks for a translation of the reply, not a fresh review", () => {
  const p = repairPrompt(
    "I found one blocking issue: no timeout on the upload handler.",
  );
  assert.match(p, /no timeout on the upload handler/); // carries the original verbatim
  assert.match(p, /none added, none dropped/);
  assert.match(p, /# Output contract/);
  // No diff: a repair is cheap and must not invite a second, different opinion.
  assert.ok(!p.includes("diff --git"));
});

test("resolveRepairTimeoutMs: its own knob, following the same idiom as the review budget", () => {
  const DEFAULT = 60_000;
  // A repair translates a reply the specialist already produced — no diff — so it defaults tighter
  // than a review, but a slow machine must still be able to raise it rather than lose the recovery.
  assert.equal(resolveRepairTimeoutMs({}), DEFAULT);
  assert.equal(
    resolveRepairTimeoutMs({ REVIEW_REPAIR_TIMEOUT_MS: "" }),
    DEFAULT,
  );
  assert.equal(
    resolveRepairTimeoutMs({ REVIEW_REPAIR_TIMEOUT_MS: "120000" }),
    120_000,
  );
  // Bad input degrades to the default rather than throwing or zeroing the budget.
  for (const bad of ["nope", "0", "-5", "1.5"])
    assert.equal(
      resolveRepairTimeoutMs({ REVIEW_REPAIR_TIMEOUT_MS: bad }),
      DEFAULT,
    );
  // The review budget is a separate knob — raising one must not move the other.
  assert.equal(
    resolveRepairTimeoutMs({ REVIEW_TIMEOUT_MS: "300000" }),
    DEFAULT,
  );
});

// --- issue #192, applied to a new trigger surface (null-result) ---------------------------------

/** Every CI workflow on disk, discovered rather than listed. */
function workflowFiles() {
  const dir = join(REPO_ROOT, ".github", "workflows");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `.github/workflows/${f}`)
    : [];
}

/** Every package.json that declares a test script — the things whose runner can go quiet. */
function testScriptManifests() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(REPO_ROOT, rel || "."))) {
      if (
        ["node_modules", "dist", ".turbo", ".git", "coverage"].includes(entry)
      )
        continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      const abs = join(REPO_ROOT, childRel);
      if (statSync(abs).isDirectory()) walk(childRel);
      else if (entry === "package.json") {
        const pkg = JSON.parse(readFileSync(abs, "utf8"));
        if (Object.keys(pkg.scripts ?? {}).some((s) => s.startsWith("test")))
          out.push(childRel);
      }
    }
  };
  walk("");
  return out;
}

test("null-result triggers on every workflow and test-script manifest on disk (#192)", () => {
  // RA-5's lesson applied to a new reviewer rather than re-learned on it: a *blocking* specialist
  // that is never triggered emits no findings and no [GAP] warning, so the run reads as a clean
  // pass. The globs are checked against what is actually in the tree, so the next workflow or
  // package cannot silently fall outside them.
  const { triggerGlobs } = specialistConfig("null-result");
  const surface = [...workflowFiles(), ...testScriptManifests(), "turbo.json"];
  assert.ok(
    surface.length > 5,
    "the discovered trigger surface must not be empty",
  );
  const missed = surface.filter((f) => !matchesAny(f, triggerGlobs));
  assert.deepEqual(
    missed,
    [],
    `null-result would not run on: ${missed.join(", ")}`,
  );
});

test("null-result does not trigger on ordinary product source", () => {
  // The other half of routing: a reviewer that fires on everything is a reviewer whose findings
  // get skimmed. Its brief is checks, not code.
  const { triggerGlobs } = specialistConfig("null-result");
  for (const notItsJob of [
    "packages/curator/src/server.ts",
    "packages/curator/ui/src/pages/Room.tsx",
    "packages/stylus/stylus/reader.py",
    "docs/specs/dev-harness.md",
  ]) {
    assert.equal(
      matchesAny(notItsJob, triggerGlobs),
      false,
      `${notItsJob} is not a check`,
    );
  }
});

// --- concurrency (ADR 0087) --------------------------------------------------------------------

test("resolveConcurrency: three by default, overridable, bad input falls back", () => {
  // Not unbounded. Each slot is a full Claude Code session, and the sequential design this replaces
  // was chosen to be "gentler on a loaded machine than N concurrent sessions" — a cap keeps that.
  assert.equal(resolveConcurrency({}), 3);
  assert.equal(resolveConcurrency({ REVIEW_CONCURRENCY: "6" }), 6);
  assert.equal(resolveConcurrency({ REVIEW_CONCURRENCY: "1" }), 1);
  for (const bad of ["0", "-2", "nope", "1.5", ""])
    assert.equal(resolveConcurrency({ REVIEW_CONCURRENCY: bad }), 3);
});

test("mapWithConcurrency: never exceeds the cap", async () => {
  // The property the cap exists for. Without it this is Promise.all, which opens every session at
  // once — eight concurrent Claude processes on a laptop that is also running the dev servers.
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
  });
  assert.equal(peak, 3);
});

test("mapWithConcurrency: results keep input order, not completion order", async () => {
  // The orchestrator zips runs back to specialists positionally, and the eval scores per case —
  // both break silently if a slow item's result lands in a fast item's slot.
  const delays = [30, 1, 20, 2];
  const out = await mapWithConcurrency(delays, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("mapWithConcurrency: a cap wider than the work does not spin idle workers", async () => {
  let started = 0;
  await mapWithConcurrency([1, 2], 16, async () => {
    started++;
  });
  assert.equal(started, 2);
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

test("mapWithConcurrency: one slow item does not hold up the ones behind it", async () => {
  // With a sequential runner, `runtime`'s 300s budget delayed everything after it. The point of the
  // pool is that a slow specialist occupies one slot rather than the whole run.
  const order = [];
  await mapWithConcurrency([50, 1, 1], 3, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(i);
  });
  assert.deepEqual(order, [1, 2, 0], "the fast items finish first");
});

test("runSpecialist: a rejected spawn is a failure, not an unhandled rejection", async () => {
  // A promise-returning spawn can reject where the synchronous one could only return an error
  // object. Left unhandled that would take down the whole run rather than one specialist.
  const spawn = async () => {
    throw Object.assign(new Error("spawn exploded"), { code: "EACCES" });
  };
  await assert.rejects(() =>
    runSpecialist({ prompt: "p" }, { spawn, retries: 0 }),
  );
});

// --- the prompt must arrive intact (the truncation hypothesis, refuted 2026-08-14) --------------

/**
 * A throwaway .mjs helper. Real invocations pass a script *path*, never `node -e`, because under
 * `shell: true` on Windows cmd.exe mangles an inline script's quotes and braces — which is itself
 * a small lesson about how much the shell flag changes.
 */
function helper(body) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-once-"));
  const file = join(dir, "h.mjs");
  writeFileSync(file, body);
  return file;
}

test("spawnOnce: a prompt larger than any real one arrives byte-identical", async () => {
  // `null-result` scored 0/9 and then 16/20 with no change to its prompt, and the leading suspect
  // was that the old `spawnSync(..., { shell: true })` path truncated large stdin on Windows —
  // null-result has the longest composed prompt on the roster at ~11,900 chars. Probing both paths
  // at 1KB…128KB showed byte-identical delivery, so that explanation is dead.
  //
  // The test stays because the property is worth holding regardless: a specialist handed a
  // truncated prompt answers `[]`, which is indistinguishable from a clean review. If delivery ever
  // does start clipping, this fails loudly instead of quietly halving the roster's recall.
  const sink = helper(
    "let n=0;process.stdin.on('data',c=>n+=c.length);" +
      "process.stdin.on('end',()=>process.stdout.write(String(n)))",
  );
  const prompt = "review this diff; ".repeat(8000); // ~144KB, an order over the real thing
  const res = await spawnOnce("node", [sink], {
    input: prompt,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  assert.equal(res.error, undefined, `spawn failed: ${res.error}`);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(Number(res.stdout), Buffer.byteLength(prompt));
});

test("spawnOnce: a child that outruns maxBuffer errors rather than returning a clipped reply", async () => {
  // `spawn` has no maxBuffer of its own, so this is enforced by hand — and it has to fail rather
  // than hand back a clipped reply, which would parse as findings the specialist never finished.
  const noisy = helper("process.stdout.write('x'.repeat(50000))");
  const res = await spawnOnce("node", [noisy], {
    input: "",
    timeout: 30_000,
    maxBuffer: 1000,
    shell: process.platform === "win32",
  });
  assert.match(String(res.error), /maxBuffer/);
});

test("spawnOnce: a child that overruns its budget reports ETIMEDOUT, so RA-2 can retry it", async () => {
  // `spawn`'s own `timeout` kills without setting this code, and the retry rule is written against
  // it — lose the code and a transient overrun stops being retried.
  const slow = helper("setTimeout(() => {}, 10000)");
  const res = await spawnOnce("node", [slow], {
    input: "",
    timeout: 500,
    maxBuffer: 1000,
    shell: process.platform === "win32",
  });
  assert.equal(res.error?.code, "ETIMEDOUT");
});
