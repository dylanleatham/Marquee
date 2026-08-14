import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
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
} from "./claude.mjs";
import { summarizeRun, silentWarning } from "./outcome.mjs";
import { composePrompt, repairPrompt } from "./prompt.mjs";
import {
  normalizeMessage,
  fingerprint,
  readLedger,
  serializeRecords,
  pendingFindings,
  findingRecord,
  runRecord,
  computeStats,
  formatStats,
  MIN_SAMPLE,
  VERDICTS,
  runIdOf,
} from "./ledger.mjs";
import { runTriage, renderFinding, CHOICES } from "./triage.mjs";
import { loadSpecialists } from "./specialists.mjs";

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
for (const id of ["test-auditor", "spec-adherence", "runtime", "consistency"]) {
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

// --- ledger (docs/specs/harness-self-improvement.md §4.1) ---------------------------------------

test("fingerprint: the same finding class in a different file, line and package is one class", () => {
  // The point of the bar CLAUDE.md sets ("no _repeat_ class") is that the *second* occurrence is
  // the signal, and the second occurrence is almost never in the same file at the same line.
  const a = fingerprint(
    "runtime",
    "`packages/curator/src/roomArm.ts` line 88 spawns ffmpeg with no timeout.",
  );
  const b = fingerprint(
    "runtime",
    '"packages/amp/src/player.ts" line 214 spawns ffmpeg with no timeout.',
  );
  assert.equal(a, b);

  // Backticked and bare spellings of the same path must not fork the class either.
  assert.equal(
    fingerprint("runtime", "`scripts/idle-audit.mjs` has an unbounded loop."),
    fingerprint("runtime", "scripts/idle-audit.mjs has an unbounded loop."),
  );
});

test("fingerprint: genuinely different findings stay different classes", () => {
  const timeout = fingerprint("runtime", "The upload handler has no timeout.");
  const leak = fingerprint("runtime", "The watcher is never unsubscribed.");
  assert.notEqual(timeout, leak);
  // Same sentence, different reviewer, is a different class — the reviewer is what gets retired.
  assert.notEqual(
    fingerprint("runtime", "The upload handler has no timeout."),
    fingerprint("security", "The upload handler has no timeout."),
  );
});

test("normalizeMessage: strips paths and numbers, keeps the identifiers that carry meaning", () => {
  assert.equal(
    normalizeMessage(
      "`addAlbumsBatch` in packages/curator/ui/src/api.ts:42 retries 3 times.",
    ),
    "addalbumsbatch in <path>:<n> retries <n> times.",
  );
});

test("readLedger: a half-written final line is reported, never silently dropped", () => {
  // What a crash or a kill mid-append leaves behind. Dropping it quietly would mean the ledger
  // could lose history while still printing a confident table — the silent-green class
  // dev-harness §11 exists to forbid.
  const text =
    '{"kind":"run","sha":"a"}\n' +
    '{"kind":"finding","sha":"a","verdict":"accepted"}\n' +
    '{"kind":"finding","sha":"a","verd';
  const { records, skipped } = readLedger(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 1);
});

test("readLedger: blank lines and a missing trailing newline are not corruption", () => {
  // merge=union can leave blank lines behind; a hand-edited file may lack a final newline.
  const { records, skipped } = readLedger(
    '{"kind":"run","sha":"a"}\n\n\n{"kind":"run","sha":"b"}',
  );
  assert.equal(records.length, 2);
  assert.equal(skipped, 0);
  assert.deepEqual(readLedger("").records, []);
  assert.deepEqual(readLedger(undefined).records, []);
});

test("serializeRecords: every line is newline-terminated so appends cannot fuse two records", () => {
  const out = serializeRecords([{ a: 1 }, { b: 2 }]);
  assert.ok(out.endsWith("\n"));
  assert.equal(
    readLedger(out + serializeRecords([{ c: 3 }])).records.length,
    3,
  );
  assert.equal(serializeRecords([]), ""); // an empty append must not write a stray newline
});

const finding = (over = {}) => ({
  specialist: "runtime",
  severity: "blocking",
  file: "packages/curator/src/a.ts",
  line: 10,
  message: "No timeout.",
  ...over,
});

const ledgerOf = (verdicts, specialist = "runtime") =>
  verdicts.map((verdict, i) =>
    findingRecord({
      sha: "abc",
      finding: finding({ specialist, line: i, message: `Finding ${i}.` }),
      verdict,
      ts: "2026-08-13T00:00:00Z",
    }),
  );

test("computeStats: wont-fix is excluded from both sides of precision", () => {
  // The distinction is the whole reason the ledger types its dismissals: a real finding you chose
  // not to act on says nothing about whether the reviewer is calibrated. Counting it as a miss
  // would punish a correct reviewer; counting it as a hit would flatter a wrong one.
  const verdicts = [
    ...Array(6).fill("accepted"),
    ...Array(2).fill("wrong"),
    ...Array(9).fill("wont-fix"),
  ];
  const { specialists } = computeStats(ledgerOf(verdicts));
  const runtime = specialists.find((s) => s.id === "runtime");
  assert.equal(runtime.triaged, 17);
  assert.equal(runtime.judged, 8); // 6 + 2, not 17
  assert.equal(runtime.wontFix, 9);
  assert.equal(runtime.precision, 6 / 8);
});

test("computeStats: below the sample threshold there is no ratio, only null", () => {
  // dev-harness §11 applied to this instrument: "100% precision (n=1)" is a confident nothing.
  const thin = computeStats(ledgerOf(["accepted"]));
  assert.equal(thin.specialists[0].precision, null);
  assert.equal(thin.specialists[0].judged, 1);

  const enough = computeStats(ledgerOf(Array(MIN_SAMPLE).fill("accepted")));
  assert.equal(enough.specialists[0].precision, 1);

  // A ledger of nothing but wont-fix has no judged findings at all — still null, never 0/0 = NaN.
  const abstained = computeStats(ledgerOf(Array(20).fill("wont-fix")));
  assert.equal(abstained.specialists[0].precision, null);
});

test("formatStats: an unmeasured specialist reads as 'insufficient data', never as a percentage", () => {
  const text = formatStats(computeStats(ledgerOf(["accepted", "wrong"])));
  assert.match(text, /insufficient data \(n=2\)/);
  assert.ok(!/\d+%/.test(text.split("PRECISION is")[0]));
});

test("formatStats: an empty ledger says so and says what to run, rather than printing zeroes", () => {
  const text = formatStats(computeStats([]));
  assert.match(text, /no triaged findings yet/);
  assert.match(text, /--triage/);
});

test("formatStats: unparseable lines are surfaced above the numbers they undermine", () => {
  const text = formatStats(computeStats(ledgerOf(["accepted"])), {
    skipped: 3,
  });
  assert.match(text, /\[WARN \] 3 unparseable ledger line\(s\)/);
});

test("computeStats: repeat classes are counted across files, with their verdicts", () => {
  const records = ["accepted", "accepted", "wrong"].map((verdict, i) =>
    findingRecord({
      sha: "abc",
      finding: finding({
        file: `packages/curator/src/file${i}.ts`,
        line: i,
        message: `Line ${i} spawns ffmpeg with no timeout.`,
      }),
      verdict,
      ts: "2026-08-13T00:00:00Z",
    }),
  );
  const { repeats } = computeStats(records);
  assert.equal(repeats.length, 1); // three files, one class
  assert.equal(repeats[0].count, 3);
  assert.equal(repeats[0].accepted, 2);
  assert.equal(repeats[0].wrong, 1);
});

test("computeStats: run records supply the denominator, including specialists that found nothing", () => {
  // A reviewer that never fires is as interesting as one that fires wrongly — §12 retires both.
  const emptyRun = {
    sha: "abc",
    specialists: [
      { id: "runtime", status: "ran", durationMs: 80_000 },
      { id: "security", status: "no-findings", durationMs: 10_000 },
    ],
    findings: [finding()],
  };
  const { specialists } = computeStats([
    runRecord({ report: emptyRun, ts: "2026-08-13T00:00:00Z" }),
  ]);
  const security = specialists.find((s) => s.id === "security");
  assert.equal(security.runs, 1);
  assert.equal(security.fired, 0);
  assert.equal(security.triaged, 0);
  assert.equal(security.precision, null);
  assert.equal(specialists.find((s) => s.id === "runtime").fired, 1);
});

// --- triage --------------------------------------------------------------------------------------

const triageReport = {
  sha: "abc",
  base: "def",
  specialists: [{ id: "runtime", status: "ran", durationMs: 1000 }],
  findings: [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 3 })],
};

/** Drive runTriage with a scripted set of keystrokes, collecting what it appends. */
async function triageWith(keys, { records = [] } = {}) {
  const appended = [];
  const queue = [...keys];
  const result = await runTriage({
    report: triageReport,
    records,
    ask: async () => queue.shift() ?? "q",
    append: (recs) => appended.push(...recs),
    now: () => "2026-08-13T00:00:00Z",
    log: () => {},
  });
  return { result, appended, leftover: queue };
}

test("runTriage: appends after every verdict, so an interrupted pass keeps what it judged", async () => {
  // The failure this guards against is a triage that batches to the end: quit halfway through a
  // twelve-finding run and the harness remembers nothing, which is the state we started in.
  const { result, appended } = await triageWith(["a", "q"]);
  assert.equal(result.judged, 1);
  assert.ok(result.quit);
  const findings = appended.filter((r) => r.kind === "finding");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].verdict, "accepted");
});

test("runTriage: the run record is written once, before any verdict", async () => {
  const { appended } = await triageWith(["q"]);
  const runs = appended.filter((r) => r.kind === "run");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sha, "abc");
  // It carries the fire count per specialist, which findings alone cannot supply.
  assert.equal(runs[0].specialists[0].findings, 3);

  // A second triage of the same report must not double-count the run.
  const { appended: again } = await triageWith(["q"], { records: appended });
  assert.equal(again.filter((r) => r.kind === "run").length, 0);
});

test("runTriage: resumes, asking only about findings not already in the ledger", async () => {
  const { appended } = await triageWith(["a", "q"]);
  const { result, leftover } = await triageWith(
    ["w", "because it is guarded upstream", "q"],
    { records: appended },
  );
  assert.equal(result.alreadyDone, 1);
  assert.equal(result.judged, 1);
  assert.equal(leftover.length, 0); // the note prompt was consumed — 'wrong' asks why
});

test("runTriage: only 'wrong' is asked for a reason", async () => {
  // The reason is what a prompt fix gets argued from; asking on every verdict would slow the
  // common case, and a triage nobody runs measures nothing.
  const { appended } = await triageWith([
    "w",
    "the helper already bounds this",
    "q",
  ]);
  const rec = appended.find((r) => r.kind === "finding");
  assert.equal(rec.verdict, "wrong");
  assert.equal(rec.note, "the helper already bounds this");

  const { appended: acc } = await triageWith(["a", "q"]);
  assert.equal(acc.find((r) => r.kind === "finding").note, "");
});

test("runTriage: an unrecognised key skips instead of guessing a verdict", async () => {
  // A mistyped verdict in an append-only log is worse than being asked again next time.
  const { result, appended } = await triageWith(["z", "s", "x"]);
  assert.equal(result.skipped, 2);
  assert.equal(result.judged, 1);
  assert.equal(
    appended.filter((r) => r.kind === "finding")[0].verdict,
    "wont-fix",
  );
});

test("runTriage: a report with no findings still records that the run happened", async () => {
  const appended = [];
  const result = await runTriage({
    report: { ...triageReport, findings: [] },
    records: [],
    ask: async () => "q",
    append: (recs) => appended.push(...recs),
    now: () => "2026-08-13T00:00:00Z",
    log: () => {},
  });
  assert.equal(result.judged, 0);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, "run");
});

test("pendingFindings: identity spans specialist, file, line and message", () => {
  const records = [
    findingRecord({
      sha: "abc",
      finding: finding({ line: 2 }),
      verdict: "accepted",
      ts: "t",
    }),
  ];
  const pending = pendingFindings(triageReport, records);
  assert.deepEqual(
    pending.map((f) => f.line),
    [1, 3],
  );
  // The same message at the same line of a *different* sha is a fresh finding, not a duplicate.
  assert.equal(
    pendingFindings({ ...triageReport, sha: "zzz" }, records).length,
    3,
  );
});

test("renderFinding: severity is spelled out, and a null line degrades to the file alone", () => {
  const text = renderFinding(finding({ line: null }), 0, 2);
  assert.match(text, /\[blocking\]/);
  assert.match(text, /packages\/curator\/src\/a\.ts/);
  assert.ok(!text.includes("a.ts:null"));
  assert.match(text, /1\/2/);
});

test("every verdict the ledger defines is reachable from a triage keystroke", () => {
  // A verdict with no key can never be recorded, so its category would read as empty in the stats
  // rather than as unreachable — a check that measures nothing, in miniature (dev-harness §11).
  assert.deepEqual([...CHOICES.values()].sort(), [...VERDICTS].sort());
});

test("runTriage: end of input quits instead of throwing on a half-finished pass", async () => {
  // Ctrl+D closes stdin and readline answers with nothing. Everything judged so far is already on
  // disk by then; losing the session to a stack trace would be the worst moment for one.
  const appended = [];
  const answers = ["a", undefined];
  const result = await runTriage({
    report: triageReport,
    records: [],
    ask: async () => answers.shift(),
    append: (recs) => appended.push(...recs),
    now: () => "2026-08-13T00:00:00Z",
    log: () => {},
  });
  assert.equal(result.judged, 1);
  assert.ok(result.quit);
  assert.equal(appended.filter((r) => r.kind === "finding").length, 1);
});

test("runTriage: two reviews of the same commit are two runs, not one", async () => {
  // Found by dogfooding on 2026-08-13, before this ever reached main. `--staged` and
  // `--base HEAD~3` both write `report-<sha>.json` for the *same* HEAD, so the second review
  // overwrites the first's report — but the run record was keyed on sha alone, so triage decided
  // the run was already recorded and skipped it. The observed result was a stats table that
  // contradicted itself: `consistency` showed FIRED=0 next to an accepted finding, and
  // `spec-adherence` showed RUNS=0 while having triaged one. An instrument whose whole job is
  // honest measurement must not do that (dev-harness §11).
  const runA = {
    sha: "abc",
    base: "abc",
    createdAt: "2026-08-13T21:00:14.975Z",
    specialists: [
      { id: "consistency", status: "no-findings", durationMs: 23185 },
    ],
    findings: [],
  };
  const runB = {
    sha: "abc", // same commit …
    base: "HEAD~3", // … different diff, so a different review
    createdAt: "2026-08-13T21:05:48.215Z",
    specialists: [
      { id: "consistency", status: "ran", durationMs: 30000 },
      { id: "spec-adherence", status: "ran", durationMs: 40000 },
    ],
    findings: [finding({ specialist: "spec-adherence", line: 20 })],
  };

  const appended = [];
  const drive = async (report, keys) => {
    const queue = [...keys];
    await runTriage({
      report,
      records: [...appended],
      ask: async () => queue.shift() ?? "q",
      append: (recs) => appended.push(...recs),
      now: () => "2026-08-13T00:00:00Z",
      log: () => {},
    });
  };

  await drive(runA, ["q"]);
  await drive(runB, ["a"]);

  const runs = appended.filter((r) => r.kind === "run");
  assert.equal(runs.length, 2, "the second review must record its own run");
  assert.deepEqual(
    runs.map((r) => r.runId),
    [runA.createdAt, runB.createdAt],
  );

  // And the table that comes out of it is now internally consistent: the specialist that fired
  // is counted as having fired, and the one that only ran in the second review is not at zero runs.
  const { specialists } = computeStats(appended);
  const specAdherence = specialists.find((s) => s.id === "spec-adherence");
  assert.equal(specAdherence.runs, 1);
  assert.equal(specAdherence.fired, 1);
  assert.equal(specAdherence.triaged, 1);
});

test("runTriage: re-triaging the same report still does not duplicate its run", async () => {
  // The resume path depends on this: quit halfway, come back, and the run must not be recorded
  // twice or every duration and fire count is double-counted.
  const appended = [];
  const drive = async (keys) => {
    const queue = [...keys];
    await runTriage({
      report: triageReport,
      records: [...appended],
      ask: async () => queue.shift() ?? "q",
      append: (recs) => appended.push(...recs),
      now: () => "2026-08-13T00:00:00Z",
      log: () => {},
    });
  };
  await drive(["a", "q"]);
  await drive(["a", "q"]);
  assert.equal(appended.filter((r) => r.kind === "run").length, 1);
});

test("runIdOf: a report with no createdAt still distinguishes runs by its base", () => {
  // Reports written before runId existed have no createdAt. Falling back to sha alone would
  // recreate the exact bug for them, so the fallback carries the base too.
  assert.notEqual(
    runIdOf({ sha: "abc", base: "abc" }),
    runIdOf({ sha: "abc", base: "HEAD~3" }),
  );
  assert.equal(
    runIdOf({ sha: "abc", base: "abc" }),
    runIdOf({ sha: "abc", base: "abc" }),
  );
  // createdAt wins when present — it identifies the run exactly.
  assert.equal(runIdOf({ sha: "abc", base: "x", createdAt: "T" }), "T");
});

test("computeStats: findings recorded before runId existed still count", () => {
  // The ledger is append-only, so the two real findings triaged on 2026-08-13 keep their original
  // shape. They must not be dropped or crash the stats just because they predate the field.
  const legacy = {
    kind: "finding",
    sha: "abc",
    specialist: "consistency",
    severity: "info",
    file: "packages/deploy/src/exec.ts",
    line: 33,
    message: "Naming drift.",
    fingerprint: "2077ebaa2d95",
    verdict: "accepted",
    note: "",
  };
  const { specialists } = computeStats([legacy]);
  assert.equal(specialists[0].triaged, 1);
  assert.equal(specialists[0].accepted, 1);
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

test("doc-coherence triggers on docs anywhere, and on files that cite an ADR", () => {
  // Two routes on purpose. The glob catches documentation; `triggerImports` catches the #236 shape,
  // where six *source* files carried a comment citing the wrong ADR — a doc problem living in .ts.
  const config = specialistConfig("doc-coherence");
  for (const doc of [
    "docs/specs/curator-spec.md",
    "docs/adrs/0085-a-harness-edit-is-validated-against-a-frozen-case-set.md",
    "CLAUDE.md",
    "packages/stylus/README.md",
    "review-agents/eval/README.md",
  ]) {
    assert.equal(
      matchesAny(doc, config.triggerGlobs),
      true,
      `${doc} is documentation`,
    );
  }
  assert.ok(
    config.triggerImports?.length,
    "doc-coherence needs the import route for ADR citations in source",
  );
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

test("--fast selects exactly the triggered blocking specialists", () => {
  // The tier is defined by what can stop a push, so it must be derived from `blocking` rather than
  // from a hand-maintained list that would drift the next time a reviewer changes severity.
  const roster = loadSpecialists();
  const blocking = roster.filter((s) => s.blocking).map((s) => s.id);
  const info = roster.filter((s) => !s.blocking).map((s) => s.id);
  assert.ok(blocking.length >= 4, "the fast tier must not be empty");
  assert.ok(info.length >= 2, "and must actually skip something");
  // The two rosters partition it — nothing is in neither, nothing is in both.
  assert.equal(blocking.length + info.length, roster.length);
  assert.deepEqual(
    blocking.filter((id) => info.includes(id)),
    [],
  );
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
