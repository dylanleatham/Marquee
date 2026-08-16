# Review-agents — known issues / follow-ups

The free-plan repo has no enforced issue tracker, so open follow-ups on the review harness
live here: version-controlled, grep-able, and reviewed in PRs. Per `dev-harness.md §12`,
each item should end as a **regression test** (in `review-agents/lib/lib.test.mjs`) or a
**reviewer prompt/config change** — not a lingering note. Delete an item when it's fixed.

To promote any of these to a GitHub issue, the text below is paste-ready.

---

### Open

- **RA-8 — a second review of the same commit destroys the first one's findings.** The orchestrator
  writes `.review-agents/report-${sha}.json`, keyed on `currentSha()` alone. On a branch with no
  commits yet — the normal state while working, and exactly what CLAUDE.md's "run it in the inner
  loop, iterating to green" asks for — every run resolves to the same base SHA and overwrites the
  last report. Fix what a review found, run it again, and the evidence that it found anything is
  gone.

  This is **RA-6's other half**. That entry fixed run _identity_ in the ledger, because `--staged`
  and `--base HEAD~3` on one commit were being counted as one run; `runIdOf` now keys on
  `createdAt`, and its doc comment states the collision plainly. The report _file_ was left keyed on
  sha, so the same collision still deletes the input before the ledger ever sees it.

  Measured on the branch that became the ADR 0091 logo work: four full reviews on an uncommitted
  branch, findings 2 → 1 → 9 → 0. Only the last survived on disk, so `--triage` had nothing to
  judge and **12 findings went unrecorded**, including two `accepted` ones that had caught real bugs
  (a path-command tokenizer that silently dropped unsupported commands, and a `.toUpperCase()` that
  drew relative curves as absolute). Losing accepted findings biases the ledger in the worst
  direction available: the verdicts most likely to survive to `review:stats` are the ones nobody
  acted on, which is the same inversion `resolveReport`'s fallback comment already warns about one
  layer up.

  **The fix**: name the report for the run, not the commit — `report-${sha}-${hash(runIdOf)}.json`
  or equivalent — and have `resolveReport` walk _every_ untriaged report rather than only the newest,
  so an interrupted session can still be judged later. The durable half is a regression test in
  `lib/lib.test.mjs`: two reports written for one sha with different `base`/`createdAt` must both
  still be resolvable. Until then the workaround is procedural and easy to forget — triage between
  rounds, or commit between them.

### Resolved

- **RA-7 — `test-auditor` could not see the harness's own code.** Fixed 2026-08-15
  ([issue #327](https://github.com/dylanleatham/Marquee/issues/327)). Its `triggerGlobs` were
  `packages/**/src/**` and `packages/stylus/stylus/**`, which excluded `review-agents/` (22 source
  files, **95 exports** in `lib` alone), `scripts/` (6) and `contract-tests/` (4) — three trees that
  `consistency` and `runtime` both already claimed. So the **blocking** reviewer that CLAUDE.md's
  "new surface ⇒ test in the same change" rule names as its enforcer was blind to the code of the
  harness enforcing it.
  This is RA-5 in a different tree, and invisible the same way: a reviewer that is never _triggered_
  emits no findings and no `[GAP]` warning. Measured on the branch that became #324 — a 12-file diff
  adding `lib/ledger.mjs` (13 exports) and `lib/triage.mjs` (5) reported `running 3/6 specialist(s)`
  and printed "No findings 🎵".
  Fixed by widening the globs, but the glob is the instance and not the fix. The durable half is a
  test that derives the trigger surface from `git ls-files` over `review-agents/`, `scripts/` and
  `contract-tests/`, so the next file added outside `packages/` cannot silently reopen the hole — and
  a second test asserting the surface stays a _surface_, since a reviewer that fires on every fixture
  and lockfile is one whose findings get skimmed. The prompt also gained a short section on the
  harness's own conventions (`node:test`, colocated `lib/*.test.mjs`), because it was written
  assuming HTTP endpoints and Roadie state transitions.
  The eval case `test-auditor-harness-surface-untested` was written **before** the fix and scored
  `not-triggered` — the outcome added in ADR 0086 precisely to tell a routing bug from a prompt one.
  Regression tests: `test-auditor triggers on first-party source outside packages/ (#327)` and
  `test-auditor still ignores what is not source` in `lib/lib.test.mjs`.
  `spec-adherence` had the identical globs and the identical gap, and is fixed in the same change —
  but only after the thing that made it safe. Its `includePackageSpecs` maps `packages/<name>` to
  specs, so `review-agents/` had no entry and widening its triggers alone would have handed a
  reviewer a diff with no spec to check it against, which is worse than not triggering: a reviewer
  asked to find drift against nothing produces confident nonsense. `TREE_SPECS` maps the non-package
  trees — `review-agents/` to dev-harness §6 and harness-self-improvement.md, `scripts/` to
  dev-harness, `contract-tests/` and `e2e/` to the integration contract and testing strategy — and
  `specsFor()` is one function over both maps so a caller cannot consult half of it.
  Regression tests: `spec-adherence triggers on first-party source outside packages/ (#327)`,
  the three `specsFor:` cases, and `spec-adherence reviewing harness code is handed dev-harness.md`,
  which goes through the real `buildContext` because a mapping that does not survive the trip into
  the prompt is not a mapping.

- **RA-6 — the ledger counted two reviews of one commit as one run.** Fixed 2026-08-13, the day the
  ledger shipped, by using it. `--staged` and `--base HEAD~3` both write `report-<sha>.json` for the
  same `HEAD`, so the second review overwrites the first's report — and `runTriage` keyed the run
  record on `sha`, decided the run was already recorded, and skipped it. The findings of the second
  review were recorded against a run record describing the first.
  The measured result was an instrument contradicting itself: `consistency` printed `FIRED=0`
  alongside an accepted finding, and `spec-adherence` printed `RUNS=0` while having triaged one.
  That is the §11 failure in its purest form — the table looked exactly like a confident,
  well-measured one.
  Fixed by `runIdOf(report)`: a run is identified by the report's `createdAt`, which is stamped per
  review, falling back to `sha|base` for reports written before the field existed (sha alone would
  recreate the bug for them). Both record kinds carry `runId`; findings written before it are still
  counted, since the verdict is what precision is made of.
  The ledger was **repaired by appending** the missing run record — the second review genuinely
  happened and its report was still on disk — rather than by rewriting the file. It is append-only;
  a correction is a new record, not an edit.
  Regression tests: `runTriage: two reviews of the same commit are two runs, not one`,
  `runTriage: re-triaging the same report still does not duplicate its run`, `runIdOf: a report with
no createdAt still distinguishes runs by its base`, and `computeStats: findings recorded before
runId existed still count` in `lib/lib.test.mjs`.
  No GitHub issue: it never reached `main`. The bug-fix workflow's issue-and-branch ceremony is for
  defects that escaped, and dogfooding on the feature branch is where this was supposed to be caught.

- **RA-5 — `test-auditor` never ran on Curator's React UI.** Fixed 2026-07-31
  ([issue #192](https://github.com/dylanleatham/Marquee/issues/192)). Its `triggerGlobs` were
  `packages/*/src/**`, and a single `*` matches exactly one path segment — so it saw
  `packages/curator/src/**` but none of the six source roots nested a level deeper:
  `packages/curator/ui/src` (all of the React UI), `packages/curator/web/src`, and the four
  `packages/fakes/*/src`. Measured beforehand: a 17-file UI-only diff reported
  `running 0/1 specialist(s)`.
  The failure was silent in a way RA-3 doesn't cover — the `[GAP]` warning fires for a specialist
  that was triggered and produced no verdict, not for one that was never triggered, so the run
  printed "No findings 🎵" while a **blocking** reviewer sat out. `spec-adherence` already used
  `packages/**/src/**`, so the two blocking reviewers disagreed about what counts as source.
  This is the gate CLAUDE.md's "new surface ⇒ test in the same change" rule leans on, so the hole
  was directly under the rule it was meant to enforce.
  Widened to `packages/**/src/**`. The durable part is the gate, not the glob: a test discovers
  every `packages/**/src` directory **from disk** and asserts each source-scoped reviewer matches
  it, so the next nested package cannot silently reopen the hole. A second test asserts every
  specialist directory declares some trigger and has the files the README documents.
  Regression tests: the four `… triggers on every packages/**/src root on disk (#192)` cases, the
  nested-`src` assertions in `globToRegExp: …`, and `every specialist directory has the three files
…` in `lib/lib.test.mjs`.
  The coverage backlog the first UI runs surfaced is tracked in
  [issue #196](https://github.com/dylanleatham/Marquee/issues/196), not here — three blocking gaps
  (`roomArm.ts` untested outright, `batchJob.ts` backoff/staleness, `api.ts` `downloadCardArtPrint`),
  kept out of the routing fix so it stayed reviewable on its own.

- **RA-4 — specialists replied in prose, so a blocking finding couldn't block.** Fixed 2026-07-26
  ([issue #117](https://github.com/dylanleatham/Marquee/issues/117)). The measured state beforehand,
  reviewing `feat/104-batch-add-and-regenerate`: _every_ specialist that had something to say said it
  in prose — `consistency` (two findings), `test-auditor` (two coverage gaps), `runtime` (a missing
  backoff), `spec-adherence` (a clean report). Only the two with nothing to report emitted JSON, so
  the contract held exactly when it didn't matter. `salvageProse` kept the substance but collapsed it
  into one unstructured **info** item with no file, line or severity — RA-4's original note recorded
  `test-auditor` writing "one blocking gap" and it not gating.
  Three parts:
  (a) **The contract moved after the diff.** It had sat before the review context, putting thousands
  of tokens between "reply with JSON only" and the moment of replying. It now ends the prompt, and it
  carries a worked two-finding example plus an explicit shape for the common case — "do not explain
  that you found nothing; respond with exactly `[]`". `composePrompt` lives in `lib/prompt.mjs` so the
  ordering is pinned by a test rather than surviving the next edit by luck.
  (b) **One reformat round before salvage.** `parseWithRepair` asks the same specialist to translate
  its own reply into the array — same findings, same severities, none added or dropped — with no diff
  attached, so it is cheap and can't smuggle in a second opinion. Exactly one extra attempt; a repair
  that also answers in prose falls through to `salvageProse` as before.
  (c) **Measurable.** The report records `repaired` alongside `unformatted`, so the prose rate is
  observed rather than assumed.
  Regression tests: the five `parseWithRepair` cases and three `composePrompt`/`repairPrompt` cases in
  `lib/lib.test.mjs`.

- **RA-3 — a blocking specialist that never ran was reported as a pass.** Fixed 2026-07-26
  ([issue #116](https://github.com/dylanleatham/Marquee/issues/116)). Two halves, matching the
  proposed resolution:
  (a) **Per-specialist budgets.** `resolveTimeoutMs(env, config)` now takes a specialist's own
  `timeoutMs` from its `config.json`, ahead of `REVIEW_TIMEOUT_MS` and the 90s default. The budget is
  a property of the reviewer, not the machine — `runtime` triggers on every source file in the repo
  and needs minutes; `security` finishes in ten seconds. Measured on a 23-file diff: `runtime` burned
  181s (90s × 2 attempts, both timing out) and `spec-adherence` 181s; given room, `runtime` finished
  in 79s and `spec-adherence` well inside 420s. Budgets set to 300s (`runtime`, `spec-adherence`),
  240s (`consistency`), 180s (`test-auditor`); everything else stays at 90s so a genuinely stuck fast
  specialist still fails quickly.
  (b) **Absence is reported like a finding.** `lib/outcome.mjs`'s `summarizeRun` separates "reviewed
  and found nothing" from "produced no verdict" (`unavailable` or unparseable-and-unsalvageable). A
  blocking specialist in the second group suppresses the "No findings 🎵" line, prints a `[GAP]`
  warning naming it, records `silentBlocking` in the report, and fails `--ci`. A non-blocking one is
  reported without gating, mirroring how findings already work. Claude Code being unreachable
  entirely is still a skip — that's the harness not running, which is visible, rather than a review
  quietly covering less than it claims.
  Regression tests: `resolveTimeoutMs: a specialist's own timeoutMs wins …`, `runSpecialist: passes
the specialist's budget through to spawn`, and the six `summarizeRun`/`silentWarning` cases in
  `lib/lib.test.mjs`.

- **RA-1 — a specialist's unparseable (prose) reply was dropped silently.** Root cause
  confirmed 2026-07-13 (reviewing `feat/curator-roadie`): `test-auditor` reported a real gap as
  a plain paragraph, not the JSON contract, and the whole review was discarded. Fixed by
  `salvageProse` in `lib/findings.mjs` — when a reply has no parseable findings array or object,
  the orchestrator surfaces the prose as a single **info** finding (never blocking) instead of
  dropping it. Regression tests: `salvageProse: …` in `lib/lib.test.mjs`.
- **RA-2 — a specialist marked unavailable on a transient spawn timeout.** Addressed in two
  parts: `REVIEW_TIMEOUT_MS` makes the budget configurable (`resolveTimeoutMs`), and
  `runSpecialist` now retries once on a timeout — and only a timeout — before giving up
  (`REVIEW_TIMEOUT_RETRIES`, default 1). Note specialists run sequentially (blocking `spawnSync`),
  so the original "parallel contention" framing was off; the retry covers the real transient case.
  Regression tests: `resolveRetries: …` and `runSpecialist: …` in `lib/lib.test.mjs`.
