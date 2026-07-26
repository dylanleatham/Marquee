import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "./util.mjs";
import {
  extractJsonArray,
  salvageProse,
  normalizeFindings,
  dedupe,
} from "./findings.mjs";
import { resolveTimeoutMs, resolveRetries, runSpecialist } from "./claude.mjs";
import { summarizeRun, silentWarning } from "./outcome.mjs";

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
});

test("matchesAny: true when any pattern matches", () => {
  assert.equal(
    matchesAny("packages/contracts/schemas/a.json", ["packages/contracts/**"]),
    true,
  );
  assert.equal(matchesAny("README.md", ["packages/**"]), false);
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

test("runSpecialist: retries once on a timeout, then succeeds (RA-2)", () => {
  let calls = 0;
  const spawn = () => {
    calls++;
    // First attempt times out; second returns a clean JSON reply.
    if (calls === 1)
      return { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) };
    return { status: 0, stdout: '{"result":"[]"}' };
  };
  const res = runSpecialist({ prompt: "p" }, { spawn, retries: 1 });
  assert.equal(calls, 2);
  assert.equal(res.ok, true);
  assert.equal(res.text, "[]");
});

test("runSpecialist: gives up after retries are exhausted on repeated timeouts", () => {
  let calls = 0;
  const spawn = () => {
    calls++;
    return { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) };
  };
  const res = runSpecialist({ prompt: "p" }, { spawn, retries: 1 });
  assert.equal(calls, 2); // initial + 1 retry
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
});

test("runSpecialist: does NOT retry a non-timeout failure", () => {
  let calls = 0;
  const spawn = () => {
    calls++;
    return { status: 1, stderr: "boom" };
  };
  const res = runSpecialist({ prompt: "p" }, { spawn, retries: 3 });
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

test("runSpecialist: passes the specialist's budget through to spawn (RA-3)", () => {
  let seen;
  const spawn = (_bin, _args, o) => {
    seen = o.timeout;
    return { status: 0, stdout: '{"result":"[]"}' };
  };
  runSpecialist({ prompt: "p", timeoutMs: 300_000 }, { spawn, retries: 0 });
  assert.equal(seen, 300_000);
  runSpecialist({ prompt: "p" }, { spawn, retries: 0 });
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
