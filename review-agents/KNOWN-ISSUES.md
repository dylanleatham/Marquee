# Review-agents — known issues / follow-ups

The free-plan repo has no enforced issue tracker, so open follow-ups on the review harness
live here: version-controlled, grep-able, and reviewed in PRs. Per `dev-harness.md §12`,
each item should end as a **regression test** (in `review-agents/lib/lib.test.mjs`) or a
**reviewer prompt/config change** — not a lingering note. Delete an item when it's fixed.

To promote any of these to a GitHub issue, the text below is paste-ready.

---

### Open

- **RA-3 — the `runtime` specialist (blocking) times out every run and is silently skipped.**
  Observed 2026-07-20 reviewing `feat/backdrop-runtime`: `runtime` reported `spawnSync … ETIMEDOUT`
  on all three review runs — the initial attempt _and_ the RA-2 retry both exceeded the 90s
  `REVIEW_TIMEOUT_MS` budget. `runtime` has the widest `triggerGlobs` (every `**/*.ts|tsx|mjs|js|py`)
  so it loads the most context and is the slowest specialist; 90s × 2 isn't enough on this Windows
  box. Two problems: (1) it never actually runs, and (2) because it's `blocking: true`, an
  **unavailable** blocking specialist does _not_ fail the review — the run still reports "0 blocking",
  so a real runtime finding (missing timeout, race, leak) would never surface and the review passes
  anyway. That's a blind spot, not just a flake.
  _Proposed resolution:_ add an optional per-specialist `timeoutMs` in `config.json` (consumed by
  `resolveTimeoutMs`/`runSpecialist`) and give `runtime` a larger budget; **and** make an
  _unavailable_ `blocking` specialist surface loudly (non-zero exit or an explicit "blocking
  specialist did not run" warning) rather than passing silently. Regression tests in
  `lib/lib.test.mjs` for both the per-specialist budget and the unavailable-blocking behavior.

- **RA-4 — most specialists reply in prose, not the JSON findings contract.** Same review: 4 of 6
  specialists (`consistency`, `spec-adherence`, `test-auditor`, and once `contract-guardian`)
  returned a plain paragraph every run. RA-1's `salvageProse` correctly stops these from being
  dropped, but a salvaged reply is always emitted as a single **info** finding with no `file`/`line`
  and no severity — so a genuinely blocking issue expressed in prose (e.g. `test-auditor` literally
  wrote "one blocking gap") **cannot block**, and findings lose their structure. `salvageProse` is a
  safety net, not the intended path; the specialists should be emitting JSON.
  _Proposed resolution:_ tighten the specialist prompt's output-format section (restate the JSON
  contract at the end of the prompt + a one-shot example of a findings array), and/or add a single
  re-prompt ("reply with JSON only") when a response isn't parseable before falling back to
  `salvageProse`. Track prose-reply rate so the fix is measurable.

### Resolved

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
