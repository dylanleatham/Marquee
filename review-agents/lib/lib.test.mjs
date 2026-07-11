import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "./util.mjs";
import { extractJsonArray, normalizeFindings, dedupe } from "./findings.mjs";

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
