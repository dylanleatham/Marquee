---
name: fix-bug
description: Fix a bug in Marquee the way this repo requires — issue, branch, a failing test you watched fail, then the fix, then close the blind spot that let it through. Use when starting work on a reported bug or a GitHub issue number.
user-invocable: true
---

# Fixing a bug in Marquee

The full procedure is [docs/specs/bug-fix-workflow.md](../../../docs/specs/bug-fix-workflow.md);
this is the operational version. The rule underneath it, from CLAUDE.md:

> A bug that reached you is also a bug the harness missed. Fix **both**: the defect, and the gap that
> let it through.

## 1. File the issue first

```bash
"C:\Program Files\GitHub CLI\gh.exe" issue create --title "<what the user sees>" --body "<repro>"
```

Title it as the **symptom**, not the cause — you do not know the cause yet, and issues get read by
their titles. Then branch:

```bash
git checkout -b fix/<issue#>-<slug>
```

## 2. Write the test and watch it fail

This is the step that gets skipped, and skipping it is the whole difference between a fix and a
guess. **A test that never went red proves nothing** — it may be asserting something that was always
true, or testing a path the bug never touched.

So: write the test, run it, and read the failure. If it passes on the first run, you have not
reproduced the bug and you do not yet know what you are fixing.

```bash
pnpm --filter <pkg> test -- --run <file>
```

Paste the red output into the PR. It is the evidence the rest of the work rests on.

## 3. Green, then widen

Fix it. Get the test green. Then widen the test to the bug's **family** — if a date comparison broke
on a month boundary, the year boundary belongs in the same test. The bug you found is rarely alone.

## 4. Close the blind spot

The defect is half the work. Name what let it through and close it durably:

- a **test** that would have caught it (you have this already if step 2 went well),
- a **contract** or type that makes the shape unrepresentable,
- a **property** rather than an example, or
- a **reviewer rule** — an entry in a reviewer's `examples.md` under `review-agents/`.

Ask directly: **what would have had to exist for this bug to be impossible, or loud?** If the answer
is "someone remembering", it is not closed.

## 5. Before the PR

```bash
pnpm run review    # three reviewers, 1-5 min depending on the diff
```

The bar is **no `[FIX ]` findings left unanswered**, not zero findings. There is nothing to record
afterwards.

The PR body says `Closes #<n>`, and should contain the red test output from step 2 and one sentence
naming the blind spot you closed.

## What not to do

- Do not fix the defect and stop. That is half the job and the half that recurs.
- Do not write the test after the fix. You will write a test that passes.
- Do not commit product code straight to `main` — the hooks are the only gate this repo has.
