# Review-agents — known issues / follow-ups

The free-plan repo has no enforced issue tracker, so open follow-ups on the review harness
live here: version-controlled, grep-able, and reviewed in PRs. Per `dev-harness.md §12`,
each item should end as a **regression test** (in `review-agents/lib/lib.test.mjs`) or a
**reviewer prompt/config change** — not a lingering note. Delete an item when it's fixed.

To promote any of these to a GitHub issue, the text below is paste-ready.

---

### Open

_None currently._

### Resolved

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
