# Bug-Fix Workflow

_A cross-cutting document. Read alongside [testing-strategy.md](testing-strategy.md) (what
"well-tested" means) and [dev-harness.md](dev-harness.md) (how green builds become trustworthy).
Those two say how we keep the system healthy while building forward. This one says how we keep it
healthy when something has already broken — the discipline for turning an escaped defect into a
permanent gain._

## 1. What a bug actually is

A bug that reached you is, by definition, a bug the harness didn't catch. So a bug is two
failures, not one:

1. **The defect** — the code does the wrong thing.
2. **The blind spot** — no test, contract, or reviewer rule was watching that behavior.

Fixing only (1) leaves (2) open: the same class of bug walks back in the next time someone
touches that code, and the suite still says green. **Every bug fix must close both.** That is the
whole procedure in one sentence; everything below is how.

This is the concrete form of the harness's own evolution rule
([dev-harness.md §12](dev-harness.md)): _"Add checks when a bug ships. Every escaped defect
should either become a test (in the codebase) or a reviewer rule (in the harness)."_ The
review-agents' `KNOWN-ISSUES.md` already lives this for the harness itself; this doc generalizes
it to all of Marquee.

## 2. The one question a bug fix must answer

Before a fix is done, you must be able to answer:

> **"Why didn't the suite catch this, and what now would?"**

There are only a few honest answers, and each points at a different guard:

| Why it escaped                              | The guard that now catches it                                    |
| ------------------------------------------- | ---------------------------------------------------------------- |
| No test exercised this path                 | A **test** at the right layer (§5)                               |
| A test existed but asserted the wrong thing | Fix the **test's assertion**, then the code                      |
| Two services disagreed on a shape           | A **contract test** at that boundary                             |
| A whole category of inputs was untried      | A **property test** (invariant, not example)                     |
| Code drifted from the spec                  | A **spec/ADR update** + a **Spec-Adherence** rule if patternable |
| A recurring design mistake, not a data path | A **reviewer rule** (review-agents), not a test                  |

"I fixed it and eyeballed it" is not on this list. If you can't name the guard, the bug isn't
fixed — it's hidden.

## 3. Test-first, always — the red step is the proof

We do bug fixes test-first for one non-negotiable reason: **a test written after the fix proves
nothing.** It passes because the code already works; you never saw it fail, so you don't know it
actually exercises the bug. A test that has never been red is a decoration.

So the order is fixed:

1. **Write the test that reproduces the bug. Run it. Watch it fail** — and read the failure. The
   message and the failing assertion must describe the _actual_ bug, not some setup error. This is
   the repro, encoded once and kept forever.
2. **Fix the code. Run the test. Watch it pass.**
3. **Run the surrounding suite** (`pnpm --filter <pkg> test`) to confirm you fixed the bug without
   breaking a neighbor.

If step 1 won't go red, you don't yet understand the bug — stop and reproduce it by hand first
(§4). Never skip to the fix because "it's obvious."

### 3.1 When a test genuinely can't go first — mutate to earn the green

Sometimes a test legitimately arrives after the code. The usual case isn't laziness: you fix a bug,
and then review (or your own second look) finds an adjacent guard you wrote but never covered — a
validation branch, a fallback, an invariant you asserted in a comment. Writing that test now is
right. But it goes green on the first run, which is exactly the situation §3 says proves nothing.

**The remedy is a mutation check: break the thing on purpose and watch the test fail.** Temporarily
revert the guard (delete the clamp, invert the condition, drop the branch), run the test, confirm it
goes red _for the reason you expect_, then restore. Thirty seconds, and the green is earned rather
than assumed — you've seen the test discriminate between working and broken code, which is the only
thing the red step was ever for.

If the test still passes with the guard removed, it isn't testing the guard. That's the bug the
mutation check exists to find, and it's a common one.

Use it as the exception, not the routine. A repro test for the reported bug still goes first — a
mutation check is what you owe a test that couldn't.

## 4. The procedure, end to end

For anything past a one-character typo, follow all of it. It is short by design.

### 0. Reproduce it by hand (before any code)

Confirm the bug is real and you can trigger it on demand. Use the `/verify` skill or drive the
affected flow directly (curator: `pnpm --filter @marquee/curator dev`, exercise the UI/endpoint).
Capture the exact inputs, the observed behavior, and the expected behavior. If you can't reproduce
it, you can't fix it — you can only guess.

### 1. File a GitHub issue

Bugs are tracked as **GitHub issues** (`gh` is installed at
`C:\Program Files\GitHub CLI\gh.exe`, authed as `dylanleatham`; call it by full path until it's
on PATH). One issue per defect. The issue body is the hand-repro from step 0:

- **Repro** — minimal steps / inputs.
- **Expected vs. actual.**
- **Scope** — which package(s), which spec section if known.
- **Severity** — see §6.

Label `bug` plus a `sev:*` label. The issue number is the anchor: the branch, the test, and the
PR all reference it, so a year from now the test comment leads straight back to the story.

### 2. Branch — before you touch code

`fix/<issue#>-<short-slug>` off `main` (e.g. `fix/23-queue-count-stale`). Conventional Commits;
never commit the fix straight to `main` (the hooks are the gate — [CLAUDE.md](../../CLAUDE.md)).

**Branch _first_, not once the fix looks promising.** A bug is easy to start investigating on
whatever branch you happen to be standing on, and by the time you notice, the fix is tangled with
unrelated work.

**If you're mid-WIP on another branch** — the common case, since bugs arrive while you're doing
something else — deal with the WIP before starting, not after:

1. **Commit it** on the branch it belongs to, if it's at a sensible point. Cleanest; do this by
   default.
2. **Stash it** (`git stash push -u`) if it isn't, then branch off `main` and pop it back later.
3. Only if neither fits: branch off `main` carrying the WIP, and accept that you'll have to
   untangle it at commit time (see the warning below).

**Do not plan to separate the changes by staging only some hunks.** `lint-staged` runs
`prettier --write` and re-stages **whole files**, so a partially-staged file gets its unstaged
hunks swept into your commit — silently, and `--amend` repeats the trick. If unrelated changes
share a file with your fix, the reliable move is to make the working tree contain **only** what
you're committing (reset the file, re-apply just the wanted edits), `git add -A` so tree and index
agree, commit, then restore the other work from a copy. Always confirm with `git show --stat HEAD`
before you trust it.

The cheap version of all this: start from a clean tree.

### 3. Red — write the failing test

Pick the layer from §5. Write the smallest test that fails _because of this bug_. Run it, confirm
it's red for the right reason. Reference the issue in the test name or a comment:

```ts
// regression: #23 — queue counts went stale after a delete (asset removed but count cached)
it("recomputes queue counts after an album is deleted", async () => { … });
```

### 4. Green — the minimal fix

Change the least code that turns the test green. Resist refactoring in the same step — a fix
tangled with a cleanup is hard to review and hard to bisect if it regresses. Cleanup is a separate
`chore/*` PR.

### 5. Widen — is this bug the whole family?

Ask: "where else does this exact mistake live?" A stale-count bug after delete probably has a twin
after _attach_ and after _detach_. Fix the family, and add a test (or a parametrized case) per
member. This is where a single reported bug becomes real hardening instead of whack-a-mole.

### 6. Close the blind spot deliberately (§2)

The regression test usually _is_ the closed blind spot. But stop and check the §2 table:

- Boundary bug → is there a **contract test**, or just a unit test on one side?
- A category of inputs → would a **property test** have caught the family in step 5 for free?
- A recurring _design_ mistake (not a data path) → add or tighten a **review-agents** rule
  instead of / in addition to a test. Record it the way `KNOWN-ISSUES.md` prescribes: the item
  ends as a test _or_ a reviewer prompt/config change, never a lingering note.

### 7. Spec check — did the bug reveal drift?

If the code was doing something the spec doesn't describe (or contradicts), the bug may be a
_spec_ bug. Per [CLAUDE.md](../../CLAUDE.md): discuss, add an **ADR** if it's a real decision, and
update the affected `docs/specs/*.md` **in the same PR**. A fix that leaves the spec lying has
created the next bug.

### 8. Review & verify

- `pnpm run type` and the affected package's tests green.
- `pnpm run review` — address findings (it keeps catching real ones: path traversal, missing
  timeouts, spec drift).
- `/verify` or a hand-drive of the real flow — the same repro from step 0 must now behave.

### 9. PR

`fix(<scope>): <what changed>`, body closes the issue (`Closes #23`). The PR is the story: the
red test, the fix, any widened family, the spec/ADR touch if any. Squash-merge; the issue closes
on merge.

## 5. Choosing the layer for the regression test

Put the guard where the bug actually lives — not always at the unit level. Reuse the
testing-strategy value ordering; a bug fix is just a targeted deposit into that suite.

| Bug shape                                                                       | Test layer                              | Why here                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| Wrong computation in pure logic (palette rule, state transition, parser, count) | **Unit**                                | Fast, precise, exactly where the defect is                           |
| Two services / a service + its on-disk format disagree on a field               | **Contract**                            | The only layer that sees both sides; a unit test on one side can't   |
| I/O did the wrong thing (file not moved, wrong payload posted, bad status)      | **Integration** (real temp dir + fakes) | The bug is in the wiring, not the pure logic                         |
| An entire class of inputs misbehaves                                            | **Property**                            | One test guards the family, and shrinks failures to a minimal case   |
| A subjective output shifted (a palette)                                         | **Golden**                              | Human decides correctness once; the test then detects _change_       |
| Cross-service protocol only breaks when assembled                               | **E2E**                                 | Last resort — slow; prefer pushing the guard down a layer if you can |

Rule of thumb: **push the guard as far down the pyramid as it will honestly go.** A bug you can
catch with a unit test should not be guarded only by an e2e test — the e2e test is slow, flaky,
and won't tell you _where_ it broke next time.

Honor the testing-strategy anti-patterns while you're here: the regression test must be able to
fail for a real reason (no **assertion mirroring**), and must not **mock the thing under test**
(curator's job is filesystem/HTTP I/O — use a real temp dir, assert on real file/HTTP state).

## 6. Triage & severity

Not every bug drops everything. Sort on the same axis testing-strategy uses to decide what's worth
testing: _probability × cost of escape_.

| `sev:` label | Meaning                                                             | Response                                                      |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `sev:high`   | Data loss, corruption, a runtime service stuck, or a security issue | Drop-everything. Fix on its own branch, ahead of feature work |
| `sev:med`    | Wrong behavior on a common path, no data loss; a workaround exists  | Fixed within the current work cycle                           |
| `sev:low`    | Cosmetic, rare-path, or annoyance                                   | Backlog; batch with nearby work                               |

A `sev:high` fix may ship before its full §5/§6 widening — but the issue stays open with a
`follow-up` note until the family and the guard are done. Shipping the stop-the-bleeding fix is
allowed; declaring the bug _closed_ without the guard is not.

## 7. Anti-patterns (name them, avoid them)

- **Fix first, test later (or never).** The cardinal sin. A test that never went red proves
  nothing (§3).
- **Testing the fix instead of the bug.** Asserting "the new code returns X" rather than "the
  reported broken scenario now behaves." The test should read like the bug report, not like the
  diff.
- **Symptom patch.** Catching the exception the bug throws instead of preventing the bad state —
  a silent-failure factory. If you must guard defensively, still fix the root cause and test _it_.
- **Over-broad fix.** Rewriting a module to fix one line. Minimal green (§4.4); cleanup is a
  separate `chore/*`.
- **Whack-a-mole.** Fixing the one reported instance and skipping the family (§5). The next
  member ships next week.
- **Silent spec drift.** "The code was wrong so I changed it" when the code matched the spec and
  the _spec_ was the bug — without touching the spec (§7 of the procedure).
- **Closing without a guard.** Marking done when you can't answer §2's question.

## 8. Definition of done

A bug is fixed when **all** of these are true:

- [ ] A test existed that failed **because of this bug**, and now passes (you watched both).
- [ ] Every test added along the way has been seen to fail — written first, or mutation-checked
      after (§3.1). No test in the PR has only ever been green.
- [ ] The surrounding suite and `pnpm run type` are green.
- [ ] The bug's **family** was checked and covered, not just the reported instance (§5).
- [ ] You can answer §2 — the blind spot is named and now guarded (test, contract, property, or
      reviewer rule).
- [ ] Any spec the bug touched is updated (or an ADR explains the deviation) in the same PR (§7).
- [ ] `pnpm run review` findings addressed; the real flow re-verified (§8 of the procedure).
- [ ] The PR `Closes #<issue>`.

## 9. What this deliberately isn't

- **Not a mandate to write an e2e test for every bug.** Most bugs are unit- or integration-level;
  push the guard down (§5). E2e is the exception.
- **Not a heavyweight process for typos.** A one-character doc/comment fix is a `chore`, no issue,
  no red test — there's no behavior to guard. The moment a change affects runtime behavior, this
  doc applies.
- **Not a coverage drive.** We add the tests real bugs demand, not tests to hit a number
  (testing-strategy §8). The suite grows where reality has bitten us — that's the point.
- **Not a substitute for the review agents.** Some defects are design-shaped, not data-shaped;
  those become reviewer rules, and this doc tells you when to reach for that instead of a test.

```

```
