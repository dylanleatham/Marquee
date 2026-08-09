#!/usr/bin/env node
// `node --test`, except that discovering zero tests is a failure instead of a green tick.
//
// Node's test runner exits 0 when it finds nothing to run:
//
//     $ mkdir empty && cd empty && node --test; echo "EXIT=$?"
//     TAP version 13
//     1..0
//     # tests 0
//     EXIT=0
//
// which is byte-for-byte what a passing run looks like to turbo, to CI, and to anyone reading the
// checks list. `packages/contracts` shipped a `test:contracts` script in exactly that state and
// nobody noticed (issue #283). Four packages in this repo drive `node --test`, and any of them
// would go the same way the day a test file is renamed out from under the default glob — which is
// the same silent-pass class as #180/#217 (ffmpeg tests skipping invisibly) and #223 (an env var
// stripped before it reached vitest). This wrapper is the durable gate for the class.
//
// What it catches, precisely: a run where node's discovery found nothing to execute — a renamed or
// relocated test file, a package that never had tests. What it cannot catch: a file that node *did*
// execute but which registers no `test()` calls, because node counts each executed file as one
// passing test. That's the runner's own model, and detecting an assertion-free test is a different
// (much harder) problem; this closes the discovery hole, which is the one that bit us.
//
// Usage — a drop-in replacement for `node --test` in a package script:
//
//     "test": "node ../scripts/node-test.mjs"
//     "test": "node ../scripts/node-test.mjs --test-concurrency=1 some/dir"
//
// Every argument is forwarded to `node --test` untouched.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A test run is unbounded by nature — it's someone else's code — so it gets an explicit cap rather
// than the ability to wedge a CI runner until the job timeout kills it with no output. Ten minutes
// matches the `timeout-minutes: 10` every job in ci.yml already carries, so this fires first and
// says why. Raise it per-package via the env var if a suite ever honestly needs longer.
const TIMEOUT_MS = Number(process.env.MARQUEE_NODE_TEST_TIMEOUT_MS ?? 600_000);

const scratch = mkdtempSync(join(tmpdir(), "marquee-node-test-"));
const tapPath = join(scratch, "summary.tap");

// Two reporters: the human-facing one keeps going to stdout exactly as before, and a TAP copy lands
// in a temp file purely so this process can read the `# tests N` line. Without pinning the stdout
// reporter, node picks `spec` on a TTY and `tap` otherwise, so the format a developer sees would
// depend on whether turbo happened to allocate one.
const args = [
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=tap",
  `--test-reporter-destination=${tapPath}`,
  ...process.argv.slice(2),
];

const child = spawn(process.execPath, args, { stdio: "inherit" });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, TIMEOUT_MS);
// Don't let the timer itself hold the event loop open once the run finishes early.
timer.unref();

child.on("error", (err) => {
  clearTimeout(timer);
  cleanup();
  console.error(`node-test: could not start the test runner — ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const tap = readTap();
  cleanup();

  if (timedOut) {
    console.error(
      `node-test: the test run exceeded ${TIMEOUT_MS}ms and was killed. ` +
        `Set MARQUEE_NODE_TEST_TIMEOUT_MS to raise the cap.`,
    );
    process.exit(1);
  }

  // A run that already failed needs no help from us, and its TAP summary may be truncated — report
  // what node reported. Only a *green* run can be lying about having asserted something.
  if (code !== 0 || signal !== null) {
    process.exit(code ?? 1);
  }

  const total = countTests(tap);
  if (total === null) {
    console.error(
      "node-test: the run exited 0 but emitted no TAP summary, so there is no evidence any test " +
        "ran. Refusing to report success — see scripts/node-test.mjs.",
    );
    process.exit(1);
  }
  if (total === 0) {
    console.error(
      `node-test: exited 0 having run 0 tests, in ${process.cwd()}.\n` +
        "A test task that asserts nothing is indistinguishable from one that passes, so this is a " +
        "failure. Either the test files moved out of node's default glob, or this package has no " +
        "tests and should not declare a test script (issue #283).",
    );
    process.exit(1);
  }

  process.exit(0);
});

function readTap() {
  try {
    return readFileSync(tapPath, "utf8");
  } catch {
    return "";
  }
}

function cleanup() {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A leftover temp dir is not worth failing a green test run over.
  }
}

/**
 * The `# tests N` line from a TAP run, or `null` if the summary is absent.
 *
 * Node emits this once, at column zero, with subtests flattened into the count — so a suite whose
 * tests are all nested still reports a non-zero total. Anchored to the start and end of the line
 * anyway, so the count can only ever come from the summary itself and not from a test name or a
 * diagnostic that happens to contain the same words.
 */
function countTests(tap) {
  const match = /^# tests (\d+)$/m.exec(tap);
  return match ? Number(match[1]) : null;
}
