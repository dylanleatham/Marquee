import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  scanForConflictMarkers,
  scanText,
} from "../scripts/check-conflict-markers.mjs";

// Issue #113: a botched resolution shipped both sides of a conflict into curator-spec.md and no
// gate noticed — prettier reads `<<<<<<< HEAD` as prose, and rewrote the closing marker into a
// nested blockquote so it looked deliberate. This is the gate. It lives in contract-tests because
// it is a property of the whole repo, not of any one package, and because this suite runs
// unfiltered on every push and PR (the hooks' `--filter=...[HEAD^1]` would skip a docs-only change).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Markers are built rather than written so this file does not trip its own scan.
const OPEN = "<".repeat(7);
const MID = "=".repeat(7);
const CLOSE = ">".repeat(7);

test("no tracked file contains a merge-conflict marker", () => {
  const hits = scanForConflictMarkers(repoRoot);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}  ${h.text}`),
    [],
    "unresolved conflict markers are committed — finish the resolution",
  );
});

test("finds every marker of a raw conflict region", () => {
  const hits = scanText(
    [`${OPEN} HEAD`, "ours", MID, "theirs", `${CLOSE} abc1234 (subject)`].join(
      "\n",
    ),
  );
  assert.deepEqual(
    hits.map((h) => [h.line, h.marker]),
    [
      [1, OPEN],
      [3, MID],
      [5, CLOSE],
    ],
  );
});

test("finds the closing marker after prettier has mangled it into a blockquote", () => {
  // The exact shape #113 shipped: prettier turned `>>>>>>> 9accb59 (…)` into blockquote markers.
  const hits = scanText("text\n> > > > > > > 9accb59 (feat: something)\n");
  assert.deepEqual(
    hits.map((h) => h.marker),
    [CLOSE],
  );
});

test("a diff3 base marker counts too", () => {
  const hits = scanText(`${OPEN} HEAD\na\n${"|".repeat(7)} base\nb\n`);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 3],
  );
});

test("a setext heading underline is not a conflict marker", () => {
  // `=======` only counts inside an open region — otherwise every markdown H1 underline and every
  // `# =======` banner comment in the repo would be a false positive, and a noisy gate gets removed.
  assert.deepEqual(scanText(`Title\n${MID}\n\nbody\n`), []);
  assert.deepEqual(scanText(`// ${"=".repeat(40)}\ncode\n`), []);
});

test("a normal nested blockquote is not a conflict marker", () => {
  assert.deepEqual(scanText("> > quoting a quote\n"), []);
});
