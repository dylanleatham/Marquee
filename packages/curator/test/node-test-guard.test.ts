import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo-wide invariant, hosted here for the same reason adr-numbering.test.ts, workflow-cost.test.ts
// and workflow-turbo-env.test.ts are: this is the leg CI runs (`test:unit`), and `scripts/` has no
// package of its own.
//
// regression: #283 — `packages/contracts` declared `"test:contracts": "node --test"` with no test
// files in the package. `node --test` prints `# tests 0` and exits 0, so turbo, CI's `static` job
// and the checks list all showed the same green a real run would have. The task had asserted
// nothing since the day it was written.
//
// That is the third sighting of one class, not a one-off: #180/#217 (ffmpeg tests skipping
// invisibly because CI never installed the binary) and #223 (VITEST_MAX_FORKS stripped by turbo's
// strict env mode, so the cap never applied) are the same shape — a check that reports success
// while measuring nothing. Per the bug-fix workflow §2 the guard for "a whole category could go
// quiet" is a gate, not another example test, so `scripts/node-test.mjs` makes a zero-test run a
// hard failure and the last case here keeps every `node --test` caller behind it.

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const guard = join(repoRoot, "scripts", "node-test.mjs");

/** Run the guard in a scratch directory containing `files`, and report what a caller would see. */
function runGuard(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "node-test-guard-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), body);
  const result = spawnSync(process.execPath, [guard], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const PASSING = `
import { test } from "node:test";
import assert from "node:assert/strict";
test("a real assertion", () => assert.equal(1, 1));
`;

describe("scripts/node-test.mjs", () => {
  it("fails when the run discovered no tests at all", () => {
    // The #283 repro: a package with nothing matching node's test glob, a green exit, and nothing
    // asserted. `helper.mjs` is deliberately named to stay outside that glob — note that a file
    // ending `-test`/`_test`/`.test` *does* match, and node counts each executed file as one test
    // even when it registers none, so the fixture name is load-bearing here.
    const { status, output } = runGuard({ "helper.mjs": "export {};" });

    expect(status).toBe(1);
    expect(output).toContain("0 tests");
  });

  it("passes a run that actually asserted something", () => {
    const { status } = runGuard({ "real.test.mjs": PASSING });

    expect(status).toBe(0);
  });

  it("reports a genuine test failure as itself, not as an empty run", () => {
    // The zero-test message must not paper over a real red, or the guard would make failures
    // *harder* to read than the silence it replaced.
    const { status, output } = runGuard({
      "real.test.mjs": `
        import { test } from "node:test";
        import assert from "node:assert/strict";
        test("this one is meant to fail", () => assert.equal(1, 2));
      `,
    });

    expect(status).not.toBe(0);
    expect(output).not.toContain("0 tests");
  });

  it("accepts a suite whose tests are all nested subtests", () => {
    // Node flattens subtests into the single top-level `# tests` count, so a nested-only suite is
    // populated. Pinned because the obvious tightening of the guard — counting test *files*, or
    // only unnested tests — would start rejecting real suites, and this says so before it ships.
    const { status } = runGuard({
      "nested.test.mjs": `
        import { test } from "node:test";
        import assert from "node:assert/strict";
        test("outer", async (t) => {
          await t.test("inner", () => assert.ok(true));
        });
      `,
    });

    expect(status).toBe(0);
  });

  // The structural half. The guard only helps where it's actually wired in, and re-adding a bare
  // `node --test` is a one-word edit that nothing else would notice — so no package may declare one.
  it("leaves no package invoking node --test without the guard", () => {
    const offenders: string[] = [];

    for (const pkgPath of workspacePackageJsonPaths()) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (/\bnode\s+--test\b/.test(script))
          offenders.push(
            `${pkgPath.slice(repoRoot.length + 1)} → "${name}": "${script}"`,
          );
      }
    }

    expect(
      offenders,
      "these scripts call `node --test` directly, so a run that discovers zero test files would " +
        "exit 0 and report green (#283). Point them at scripts/node-test.mjs instead.",
    ).toEqual([]);
  });
});

/** Every workspace member's package.json, per the globs in pnpm-workspace.yaml. */
function workspacePackageJsonPaths(): string[] {
  const parents = [
    join(repoRoot, "packages"),
    join(repoRoot, "packages", "fakes"),
  ];
  const paths = [join(repoRoot, "package.json")];

  for (const dir of ["contract-tests", "e2e", "review-agents"])
    paths.push(join(repoRoot, dir, "package.json"));

  for (const parent of parents) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(join(parent, entry.name, "package.json"));
    }
  }

  // `packages/fakes` is a glob parent, not a package, and `packages/stylus` is Python — both are
  // swept up by the loop above and simply have no package.json to read.
  return paths.filter((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
}
