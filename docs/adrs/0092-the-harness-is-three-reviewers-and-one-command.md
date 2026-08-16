# ADR 0092 — The harness is three reviewers and one command

- **Date:** 2026-08-16
- **Status:** Accepted
- **Supersedes:** [ADR 0085](0085-a-harness-edit-is-validated-against-a-frozen-case-set.md),
  [ADR 0088](0088-a-review-samples-each-specialist-and-unions-the-findings.md),
  [ADR 0089](0089-the-retro-proposes-and-a-human-accepts.md)
- **Amends:** [ADR 0086](0086-a-specialist-may-be-given-context-found-by-search.md) (the reviewer it
  was written for, `doc-coherence`, is merged into `spec-adherence`; the mechanism it decided is
  kept)

## Context

Between 2026-07-10 and 2026-08-15 the review harness grew from six specialists to eight, then
acquired a layer to govern itself: a committed findings ledger with an interactive triage pass, a
stats table, a frozen eval set with a recorded baseline, and a retro command that reads all of it and
proposes changes. Each step was individually well-argued and each shipped with tests.

What it added up to, measured on 2026-08-16:

|                                               |                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A full review                                 | 8 reviewers × 3 samples = **24 Claude Code sessions**, ~10 minutes                                           |
| Commands to know                              | `review`, `review --fast`, `review --triage`, `review:stats`, `review:eval`, `review:retro`                  |
| Harness code                                  | 6,934 lines of `.mjs` under `review-agents/`, of which 2,899 are tests of the harness itself                 |
| Harness prose                                 | `dev-harness.md` §6 (229 lines) + `harness-self-improvement.md` (687 lines) + the review half of `CLAUDE.md` |
| Records in `ledger.jsonl`                     | **4**                                                                                                        |
| Decisions the ledger or the retro had changed | **0**                                                                                                        |

The owner's report is the finding that matters: the harness took too long, cost too much, and — the
part no measurement would have caught — _it was not possible to tell what it was doing, what it had
found, or what it was asking for._ A review ended with findings on screen, a JSON report on disk, a
prompt to run `--triage`, a ledger to commit, and a reminder about `review:eval`. The output was a
to-do list about the harness, appended to the to-do list about the code.

Three specific things went wrong, and they are worth naming because each was a locally sound
decision:

1. **The measurement layer outgrew what it measured.** ADR 0085's eval and 0089's retro exist to
   execute dev-harness §12's "delete checks that generate more noise than signal." That rule was
   genuinely unexecutable before — but the instrument built for it cost ~1,900 lines of code and
   ~1,500 lines of tests, and after three days it held four records. The rule it serves can be
   executed by a person who notices the same wrong finding twice.
2. **Sampling bought recall with wall clock, and wall clock was the binding constraint.** ADR 0088's
   measurement is real: per-run detection is 33–80%, and a union of three runs recovers findings a
   single run misses. But it tripled the cost of the one thing CLAUDE.md asks for — running the
   reviewers _in the inner loop_ — and the actual failure mode was not "the review missed something,"
   it was "the review is too expensive to run."
3. **Four of the eight reviewers were not earning their session.** By the harness's own baseline:
   `contract-guardian` 0/1 recall and a trigger (`packages/contracts/**` only) that essentially never
   fires; `consistency` with no must-find cases at all and one shipped finding that was a naming nit;
   `runtime` 1/4. `security` overlaps almost exactly with the built-in `/security-review`, and
   `runtime` with `/code-review` — both maintained by someone other than this repo.

## Decision

**The harness is three reviewers, one command, one screen of output.**

```bash
pnpm run review    # ~1-2 minutes
```

1. **Roster of three**, each encoding a class of defect that has escaped _this repo_ more than once
   and that a general-purpose reviewer could not know to look for:
   - `null-result` (blocking) — a new check that no-ops into a green tick.
   - `test-auditor` (blocking) — new surface without a test.
   - `spec-adherence` (info) — code ↔ spec drift **and** doc ↔ doc drift, merged from the former
     `doc-coherence`. Both halves ask "what else now disagrees with this change?"; neither needs its
     own session.

   Retired: `contract-guardian`, `consistency`, `runtime`, `security`. Generic correctness, security
   and style review is delegated to `/code-review` and `/security-review`.

2. **One sample per reviewer.** ADR 0088's measurement stands and is not being disputed; its default
   is reversed. A review is a signal, not a proof. If a change warrants more confidence, run it
   twice — that is two minutes and it is a decision made per-change, not a tax on every change.

3. **No state between runs.** The ledger, triage, stats, eval set, baseline and retro are deleted.
   The only artifact a run leaves is `.review-agents/report-*.json`, which is gitignored and has
   exactly one reader: the Stop hook that notices reviewable source changed and the reviewers never
   ran.

4. **Findings are labelled `[FIX ]` and `[note]`**, not `[BLOCK]` and `[info ]`. The tag says what to
   do, not what category the finding is in.

5. **`harness-self-improvement.md` is deleted** rather than marked superseded. It is a 687-line
   implementation plan for machinery that no longer exists; leaving it in `docs/specs/` would make it
   the largest description of a system that is now 500 lines of prose. Its history is in git, and the
   parts worth keeping are quoted in dev-harness §6, §11 and §12.

## Consequences

**Good**

- A review is ~1-2 minutes and 3 sessions instead of ~10 minutes and 24. It is now cheap enough to
  run in the inner loop, which is what every version of this document has asked for and none has got.
- One command, and the output is the whole result. Nothing to triage, commit, or remember afterwards.
- 20,393 lines deleted from `review-agents/` (24,082 → 3,689 tracked lines; most of the bulk was the
  eval set's frozen diff patches). Executable harness code: 6,934 → 2,796 lines of `.mjs`. Harness
  prose: `dev-harness.md` §6 229 → 147 lines, `harness-self-improvement.md` 687 → 0, `CLAUDE.md`
  132 → 78.
- A reviewer that fires rarely and vaguely is no longer subsidised by the roster's size.

**Bad, and accepted deliberately**

- **Recall drops.** Union-of-three found things one run does not. This is the real cost, and it is
  paid knowingly: a review that runs every session at 1× beats a review that runs before the PR at 3×.
- **No measurement of the reviewers.** Whether `test-auditor` is precise is now a matter of the
  owner's judgement rather than a table. With three reviewers and one person, judgement is adequate;
  it would not be with ten reviewers and a team.
- **Four classes lose their dedicated watcher.** Missing timeouts, hardcoded secrets, breaking schema
  changes and naming drift are now covered by generic tooling, by tests, or by nobody. If one of them
  ships a bug, the fix is to bring back that reviewer — cheap, since the prompts are in git history at
  `af1dde0` — not to rebuild the roster.
- **Superseding three ADRs three days after they were accepted** is a bad look, and it is the honest
  record. The work in 0085, 0088 and 0089 was competent; it was aimed at making the reviewers better
  when the problem was that the harness had stopped being usable. Building the governance before the
  thing governed has any operating history is the mistake to learn from.

**The rule this leaves behind**, recorded in dev-harness §12: _the machinery that governs a check
must cost less than the check._ Adding a fourth reviewer, or any command besides `pnpm run review`,
is now a decision that has to argue against this ADR.
