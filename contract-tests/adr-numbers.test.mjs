import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  checkAdrNumbers,
  adrsIn,
  highest,
} from "../scripts/check-adr-numbers.mjs";

// Issue #151: 0022, 0023, and 0026 were each allocated to two different decisions, because parallel
// branches each took "the next number" and nothing checked on merge. This lives in contract-tests
// for the same reason the conflict-marker gate does — it's a property of the whole repo, not of any
// package, and this suite runs unfiltered on every push and PR (the hooks' `--filter=...[HEAD^1]`
// would skip a docs-only change).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const adrDir = join(repoRoot, "docs", "adrs");

test("no ADR number is used twice, and every heading matches its filename", () => {
  assert.deepEqual(checkAdrNumbers(adrDir), []);
});

test("every ADR is numbered and reachable", () => {
  const adrs = adrsIn(adrDir);
  assert.ok(adrs.length > 0, "expected to find ADRs");
  assert.ok(
    adrs.every((a) => a.number),
    "every ADR filename should start with a 4-digit number",
  );
});

/** A throwaway ADR directory, so the failure cases don't need broken files committed to the repo. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "adr-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), body);
  return dir;
}

test("catches the same number used twice — the bug this exists for", () => {
  const dir = fixture({
    "0001-first.md": "# ADR 0001 — First\n",
    "0002-second.md": "# ADR 0002 — Second\n",
    "0002-also-second.md": "# ADR 0002 — Also second\n",
  });
  const problems = checkAdrNumbers(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ADR 0002 is used by 2 files/);
  // Naming both files matters: the point is to say which two collided.
  assert.match(problems[0], /0002-also-second\.md/);
  assert.match(problems[0], /0002-second\.md/);
  // And to point at the next free number, so the fix is obvious.
  assert.match(problems[0], /highest is currently 0002/);
});

test("catches a heading that disagrees with its filename (a half-finished renumber)", () => {
  const dir = fixture({
    "0007-renamed.md": "# ADR 0003 — Renamed but not retitled\n",
  });
  const problems = checkAdrNumbers(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /heading says ADR 0003 but the filename says 0007/);
});

test("catches an unnumbered filename and a missing heading", () => {
  assert.match(
    checkAdrNumbers(fixture({ "notes.md": "# ADR 0001 — x\n" }))[0],
    /doesn't start with a 4-digit ADR number/,
  );
  assert.match(
    checkAdrNumbers(fixture({ "0001-x.md": "Some prose, no heading\n" }))[0],
    /no "# ADR NNNN" heading found/,
  );
});

test("a clean directory reports nothing", () => {
  const dir = fixture({
    "0001-first.md": "# ADR 0001 — First\n",
    "0002-second.md": "# ADR 0002 — Second\n",
  });
  assert.deepEqual(checkAdrNumbers(dir), []);
  assert.equal(highest(adrsIn(dir)), "0002");
});
