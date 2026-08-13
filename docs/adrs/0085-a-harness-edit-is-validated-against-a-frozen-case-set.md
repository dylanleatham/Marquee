# ADR 0085 — A harness edit is validated against a frozen case set

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing. Amends [dev-harness.md](../specs/dev-harness.md) §11 (the "prompt
regression signals" bullet stops being aspirational) and §6 (editing a specialist now has a gate).
Implements [harness-self-improvement.md](../specs/harness-self-improvement.md) §4.2, Phase 2, and
builds on §4.1's ledger ([ADR-less, shipped 2026-08-13](../specs/harness-self-improvement.md)).

## Context

The six review specialists are prompts. Their `system-prompt.md`, `examples.md` and `config.json`
decide what gets flagged and what gets missed — which makes them behaviour, and every other piece of
behaviour in this repo has a test behind it.

They did not. Every edit to a specialist since the harness was built shipped unvalidated, and the
record shows edits that mattered: RA-4 moved the output contract after the diff and rewrote what the
specialists are shown; RA-3 changed four timeout budgets; RA-5 widened two trigger globs. Each was
argued for from reasoning, and each is probably right. None was measured. An improvement and a
regression looked identical from outside, so the only available evidence was that the person making
the change believed in it.

dev-harness §11 has named the missing piece since the harness was designed —

> **Prompt regression signals** — periodic re-benchmarks in `review-agents/eval/` catch cases where
> a prompt change degrades finding quality.

— and `review-agents/eval/` did not exist. The ledger (§4.1) closed the adjacent gap: it now records
whether a reviewer's findings were _right_. That is a different question from whether an _edit_ made
it better, and it cannot answer the second one — the ledger only ever sees the reviewer as it is
today, on whatever diffs happened to come along.

The failure mode this guards against is specific. Self-improving harnesses do not usually fail by
having a bad idea; they fail by **prompt drift** — an edit that fixes the case in front of it and
quietly costs recall on five cases nobody re-ran. That is the failure the literature on the pattern
puts the validation stage there to catch ([Self-Harness](https://arxiv.org/html/2606.09498v1), and
see §2 of the spec).

## Decision

**A change to anything under `review-agents/` is validated against a frozen case set before it
lands.**

- `review-agents/eval/cases/<id>/` holds a `case.json` and a frozen `diff.patch`. A case is
  `must-find` (this reviewer should flag this) or `must-not-find` (it should stay quiet).
- `node review-agents/eval/run.mjs` scores every case and compares the result to the committed
  `eval/baseline.json`. An edit may not lower any specialist's recall or raise its false positives.
- Improving the numbers is allowed and expected — write a new baseline **in the same PR**, so the
  improvement is a reviewable diff rather than an assertion in a commit message.
- The case set seeds from this repo's own history. Every `fix(...)` commit on `main` is a bug that
  got past the reviewers, so its reverse diff reintroduces it.

Four scoring decisions worth recording, because each rules out a way of being wrong:

1. **Four outcomes, not two.** `not-triggered` — the specialist's routing globs never selected these
   files — is reported separately from `miss`. That is RA-5 ([#192](https://github.com/dylanleatham/Marquee/issues/192))
   in measurable form: a reviewer that is never _asked_ produces no findings and no `[GAP]` warning,
   so the run reads as a clean pass. Folding it into `miss` would send someone to fix a prompt when
   the bug is in a glob.
2. **Repeats, with a majority.** Model output varies run to run, so one execution is not a
   measurement; the default is three. A gate that flakes is a gate that gets disabled.
3. **A must-not-find fails on a _blocking_ finding, not any finding.** A reviewer noticing something
   true-but-minor on a clean diff is doing its job. A blocking finding on a clean diff is what stops
   a push and teaches someone to reach for `--no-verify`.
4. **A shrinking suite is a regression.** A specialist the baseline covers but the run does not score
   is reported as a regression, because deleting cases is the cheapest possible way to make any gate
   go green.

## Consequences

**It runs locally, and cannot run in CI.** A GitHub runner has no `claude` binary and no auth —
which is exactly why dev-harness §6 put review on the developer's machine ("no self-hosted runner to
maintain, no runner-inherited auth to manage"). An eval job in a workflow would be a check that can
never measure anything, which §11 forbids more strongly than it forbids skipping a check. CI covers
`lib/eval.test.mjs` — the scoring logic and the assertion that every case on disk is well-formed —
and nothing more. **The gate is therefore a human discipline, not an enforced one**, and that is a
real weakness of this decision rather than a detail: nothing stops a `review-agents/` change landing
unevaluated. It is accepted because the alternative is a self-hosted runner holding a Claude
credential, which is a larger and more permanent cost than the one it removes.

**It costs sessions.** Roughly `cases × repeats` on a cold cache — the current eight cases at the
default three repeats is 24 real reviews. Results cache on the case, the diff, and that specialist's
own prompt/examples/config/model, so editing one reviewer re-runs only its cases.

**A mock run must not touch the cache**, and this was learned by breaking it: a `REVIEW_MOCK=1`
pipeline check seeded the cache with its canned empty findings, and the next real run read them back
and printed `miss [cached]` without spending a session. A cached nothing served as a measurement is
the precise failure the eval exists to prevent, reproduced inside the eval. `cachePolicy` now
excludes mock runs from both reads and writes, with a regression test.

**Reversed diffs read a little easy.** `git show -R` turns the fix's own explanatory comments into
_deleted_ lines, so the reviewer sees `- # this is the one step that can hang` going away — a hint
the original reviewer never had. Deleting a safety comment genuinely is a signal, so the cases are
not invalid, but recall on this set reads higher than reality. The baseline is a regression gate and
must not be quoted as a measure of how good the roster is.

**Coverage is thin and unevenly distributed.** Eight cases at the outset: five `must-find` (four
`runtime`, one `test-auditor`) and three `must-not-find`. `security`, `spec-adherence` and
`contract-guardian` have none, so their rows read `0/0` — honest, and not coverage. The gate is only
as strong as the set, and the set is young.

**Phase 3 depends on this.** The two proposed specialists (`doc-coherence`, `null-result`) are meant
to land cases-first: write the cases, watch the current roster fail them, then add the reviewer.
`not-installed` exists as an outcome so a case can be committed before its reviewer.
