import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "./util.mjs";
import { extractJsonArray, normalizeFindings, dedupe } from "./findings.mjs";
import { resolveTimeoutMs } from "./claude.mjs";

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
