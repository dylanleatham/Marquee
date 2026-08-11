# ADR 0066 — A test task that runs no tests is a failure

- **Status:** Accepted
- **Date:** 2026-08-09
- **Closes** [#283](https://github.com/dylanleatham/Marquee/issues/283).
- **Relates to** [ADR 0064](0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md), which put
  `test:contracts` into the consolidated `static` job where this was reporting green.

## Context

`packages/contracts/package.json` declared `"test:contracts": "node --test"`. The package contains
no test files, and `node --test` with nothing to run prints `# tests 0` and **exits 0**:

```
$ mkdir empty && cd empty && node --test; echo "EXIT=$?"
TAP version 13
1..0
# tests 0
EXIT=0
```

To turbo, to CI's `static` job, and to the checks list on a PR, that is byte-for-byte what a passing
run looks like. The task had asserted nothing since the day it was written, and nothing anywhere in
the harness could tell the difference.

The coverage itself was never missing — it lives in the separate `@marquee/contract-tests` workspace
(38 tests at the time of writing), which does run. What was missing was any relationship between the
name of a task and whether it measured anything.

**This is the third sighting of one class, not a one-off.** Each previous instance was fixed as an
instance:

| Issue          | The check that measured nothing                                                  |
| -------------- | -------------------------------------------------------------------------------- |
| [#180], [#217] | ffmpeg tests skipped invisibly — CI never installed the binary                   |
| [#223]         | `VITEST_MAX_FORKS` stripped by turbo's strict env mode, so the cap never applied |
| [#283]         | `node --test` discovered zero test files and exited 0                            |

[#180]: https://github.com/dylanleatham/Marquee/issues/180
[#217]: https://github.com/dylanleatham/Marquee/issues/217
[#223]: https://github.com/dylanleatham/Marquee/issues/223
[#283]: https://github.com/dylanleatham/Marquee/issues/283

Per [bug-fix-workflow §2](../specs/bug-fix-workflow.md), "a whole category of inputs was untried"
takes a gate, not another example test. Four packages drove `node --test` directly, so any of them
could have gone the same way the day a test file was renamed out from under node's default glob.

## Decision

**1. `packages/contracts` loses its `test:contracts` script.** It is the package _under_ test, not a
test package. Every one of its exports is asserted from `@marquee/contract-tests` (whose stated job
is exactly that, and which has the ajv setup for it) or from the consumer packages that use them.
Adding a second, ajv-less test home inside a types package would have duplicated those assertions
and split them across two places — so option (b), "add the tests the name promises", would have
meant re-writing tests that already exist somewhere better.

`packages/fakes/fake-hue-bridge` loses its `test` and `test:unit` scripts for the same reason: it is
a four-line stub with no test files, and its own source comment already says "a fake without its own
test suite is not a fake, it's a wish." When the fake is actually written, its suite arrives with
it. [testing-strategy.md](../specs/testing-strategy.md) still calls for that suite; nothing here
changes the plan, only the claim that it exists today.

**2. Every remaining `node --test` caller goes through `scripts/node-test.mjs`,** a wrapper that
forwards its arguments untouched and fails when the run reported zero tests. It runs two reporters —
the human-facing one to stdout as before, and a TAP copy to a temp file it reads `# tests N` from.

It bounds the run at ten minutes (`MARQUEE_NODE_TEST_TIMEOUT_MS`), matching the `timeout-minutes: 10`
every CI job already carries, so a wedged suite fails with a reason rather than at the job timeout
with none.

**3. Two guards keep it that way**, in `packages/curator/test/node-test-guard.test.ts` — hosted there
for the same reason `adr-numbering.test.ts` and `workflow-cost.test.ts` are: it is the leg CI runs,
and `scripts/` has no package of its own.

- The behavioural half runs the wrapper against scratch directories: zero tests fails, a real test
  passes, a genuine red is reported as itself, and a nested-only suite still counts as populated.
- The structural half asserts **no package.json script invokes `node --test` directly**. Re-adding
  one is a one-word edit that nothing else would notice.

## Consequences

- A `node --test` package whose test files move out of the default glob now goes red instead of
  green. That is the whole point, and it is the failure mode that will actually happen.
- CI output for those packages is now node's `spec` reporter rather than `tap`. Previously the format
  depended on whether a TTY was allocated; now it is the same locally and in CI.
- **The gate does not catch an executed test file that registers no `test()` calls** — node counts
  each executed file as one passing test, so such a file reads as populated. Closing the discovery
  hole is what this ADR does; detecting an assertion-free test is a different and much harder
  problem, and is deliberately out of scope.
- The wrapper only helps `node --test`. The six vitest packages have their own zero-test behaviour
  (vitest already fails a run that matches no test files), so they need no equivalent.
- One coverage gap surfaced while establishing that `packages/contracts` was covered elsewhere:
  `readPatternOverride` — which carries the
  [ADR 0039](0039-one-motion-picker-clip-patterns-are-selectable.md) field rename that lets Conductor
  ([ADR 0019](0019-conductor-scan-reads-asset-store.md)) read albums saved under
  [ADR 0035](0035-streaming-effect-is-a-per-album-opt-in.md)'s names — had no test anywhere. It now
  has six, in `contract-tests`.
