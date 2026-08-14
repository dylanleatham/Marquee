# Eval — the gate on harness edits

A specialist's `system-prompt.md`, `examples.md` and `config.json` are behaviour. Until this
directory existed, editing them was a change with no test behind it: an improvement and a regression
looked identical from the outside. This is the frozen case set that tells them apart.

Design and rationale: [harness-self-improvement.md §4.2](../../docs/specs/harness-self-improvement.md).

```bash
node review-agents/eval/run.mjs                    # score every case, compare to the baseline
node review-agents/eval/run.mjs --case <id>        # one case
node review-agents/eval/run.mjs --reviewer runtime # one specialist's cases
node review-agents/eval/run.mjs --repeat 1         # cheaper, noisier (default 3)
node review-agents/eval/run.mjs --write-baseline   # record this run as the new baseline
node review-agents/eval/run.mjs --no-cache         # ignore cached results
node review-agents/eval/run.mjs --aggregate union  # score N runs as a union, not a majority
```

`pnpm run review:eval` is the same thing.

## It runs locally, never in CI

A GitHub runner has no `claude` binary and no auth — which is exactly why dev-harness §6 put review
on the developer's machine in the first place ("no self-hosted runner to maintain, no
runner-inherited auth to manage"). An eval job in a workflow would be a check that can never measure
anything, which §11 forbids more strongly than it forbids skipping the check.

So CI covers `lib/eval.test.mjs` — the scoring logic, the case-file schema, and the assertion that
every case on disk is well-formed — and nothing else. **The discipline is human: run the eval before
you merge a change to `review-agents/`.**

## Anatomy of a case

```
cases/<id>/
├── case.json     # kind, target specialist, and what must (or must not) be found
└── diff.patch    # the change, frozen
```

```jsonc
{
  "id": "runtime-rename-over-served-file",
  "source": "commit:436b1d1 (reversed)",
  "kind": "must-find", // or "must-not-find"
  "specialist": "runtime",
  "expect": {
    "file": [
      "packages/curator/src/albums/actions.ts",
      "packages/curator/src/media/video.ts",
    ],
    "matches": ["race|EPERM|still (being )?served"], // regex, case-insensitive
    "severity": "blocking", // optional
  },
  "forbid": ["…"], // must-not-find only: patterns that count as a false positive
  "notes": "Why this is a bug, and where it escaped.",
}
```

A `must-find` case needs a `file` or a `matches` — an empty `expect` would make any finding at all
count as a hit, and the case would pass without measuring anything.

**Prefer `matches`; be careful with `file`.** A diff usually has more than one place the same bug is
visible from, and the reviewer picks one. The very first real run of this suite scored a false miss
because of it: `runtime` found the rename-over-a-served-file race and reported it at
`media/video.ts:266`, while the case pinned `albums/actions.ts`. Both were true. `file` therefore
accepts a **list**, and a case that pins a single path should have a reason to.

Run with `--show` when a case misses. It prints what the specialist actually said, which is the only
way to tell a genuine recall gap from an `expect` that is too narrow — and baking the second into a
baseline would leave the gate protecting a number that was never real.

For a `must-not-find` case, a false positive is a **blocking** finding, or anything matching
`forbid`. Counting every info finding would make the metric unusable: a reviewer noticing something
true-but-minor on a clean diff is doing its job, while a blocking finding on a clean diff is what
stops a push and teaches someone to reach for `--no-verify`.

## Four outcomes, not two

| outcome         | meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `hit`           | triggered, ran, and said the thing (or stayed quiet, for must-not-find) |
| `miss`          | triggered and ran, and didn't                                           |
| `not-triggered` | its routing globs never selected these files, so it **could not have**  |
| `not-installed` | no such specialist on disk — a case written ahead of its reviewer       |

`not-triggered` is the RA-5 failure ([#192](https://github.com/dylanleatham/Marquee/issues/192)) in
measurable form. A reviewer that is never selected produces no findings and no `[GAP]` warning, so
the run reads as a clean pass. Folding it into `miss` would hide the difference between a reviewer
that looked and a reviewer that was never asked — which is the confusion that let a blocking
specialist sit out every UI review for weeks.

## Adding a case

The set seeds itself from this repo's own history. Every `fix(...)` commit on `main` is a bug that
got past the reviewers, so its **reverse diff** is a change that reintroduces it:

```bash
node review-agents/eval/seed-from-history.mjs <sha> --specialist runtime \
  --exclude 'packages/**/tests/**' --exclude 'docs/**' --exclude '**/*.md'
```

Quote the globs — an unquoted `packages/**/tests/**` is expanded by your shell before Node sees it,
and the exclusion then silently matches nothing.

Then **write the `expect` block by hand.** The seeder deliberately leaves a TODO; generating the
expectation from the commit message would mean the case set was authored by the same kind of model
it scores (the independent-rater problem, §2 of the spec). A test fails if a TODO survives.

Two shapes need `--forward` instead of reversal:

- **test-auditor cases.** Its rule is "new surface arrived without a test", so the case is a real
  feature commit with its test files excluded — including colocated ones, which need
  `--exclude '**/*.test.*'`, not just a `tests/` directory glob.
- **must-not-find cases.** A clean merged feature already _is_ the case. Reversing it would produce
  a revert, which is a different change with different risks.

### `null-result` measured 0/9, then 16/20, and nothing about it changed

The most important number in this directory is one that moved without a cause.

On 2026-08-13, `null-result` was scored three times over three revisions of its prompt and config
and produced **zero detections in nine runs**. It was documented as broken, marked unproven in the
roster, and a hand-authored case (`null-result-new-step-skips-silently`) was written to work out
whether the fault was the prompt or the cases. That case detected at 1/3, and the conclusion drawn
was that a reversed guard-removal reads as a deliberate revert and is the wrong shape for this
reviewer.

On 2026-08-14 the baseline was recorded at `--repeat 5`, and the same four cases scored:

| case                                  | hits |
| ------------------------------------- | ---- |
| `null-result-bare-node-test`          | 5/5  |
| `null-result-ffmpeg-tests-skip`       | 4/5  |
| `null-result-turbo-strips-fork-cap`   | 4/5  |
| `null-result-new-step-skips-silently` | 3/5  |

**16/20 — 80% per-run detection, and 4/4 cases.** The three "wrong shape" cases scored 13/15.
`git log -- review-agents/null-result/` shows no commit between the two measurements: same prompt,
same examples, same config.

So the earlier conclusion was wrong, and this section previously stated it as established fact. What
replaced it is not a better conclusion but a live question. Two candidates were considered, and **the mechanical one has been tested and refuted.**

1. **The spawn rewrite ([ADR 0087](../../docs/adrs/0087-specialists-run-concurrently-under-a-cap.md))
   — ruled out.** Every 0/9 measurement predates it and used `spawnSync` with `shell: true`; every
   measurement since uses `spawn` with an explicit `stdin.end()`. Since `null-result` has the longest
   composed prompt on the roster (11,887 chars against `runtime`'s 8,273), a path that clipped large
   stdin would have starved this reviewer first, and a specialist handed a truncated prompt answers
   `[]` exactly as observed.

   Both paths were probed head to head at 1KB, 4KB, 8KB, 11,887 (the real size), 16KB, 32KB, 64KB
   and 128KB, comparing byte length and SHA-256 of what actually arrived. **Every size delivered
   identically on both paths.** Nothing was being truncated. Kept as three regression tests on
   `spawnOnce` in `lib/lib.test.mjs`, because the property is worth holding even though it was never
   the culprit.

2. **Something correlated the runs, on a timescale of about a day.** This is what is left, and it is
   not a satisfying answer. Nine consecutive misses against a true rate of 80% has probability
   0.2⁹ ≈ 5×10⁻⁷, so the runs cannot have been independent draws from today's distribution. Load,
   time of day, or an upstream change to the model or CLI between 2026-08-13 and 2026-08-14 would
   all produce this shape, and none of them is something this repo can pin.

   Note the one fact that argues against a blanket upstream shift: `runtime` measured 50% on both
   days, unchanged. Whatever moved did not move everything.

The methodological point stands regardless: this suite is the only reason any of this is visible,
and it has now caught its own earlier conclusion being wrong. A number from nine runs is not a fact.

### A fix that reconciled every copy reverses into a self-consistent diff

Found by writing `doc-coherence-address-in-three-places` and watching it correctly fail. The fix
(#260) updated the runbook **and** the bring-up checklist in one commit, so reversing the whole thing
put both back to "two places" — leaving a diff that contradicts nothing. `doc-coherence` said
nothing, and was right to: it looks for one copy of a fact going stale while another is edited, and
there was no such copy.

The case only became valid once the reverse was restricted to **one** of the two files
(`--exclude docs/bring-up-checklist.md`), leaving the checklist saying "three" in the tree while the
diff says "two".

The general trap: **a reversed fix is only a case if the reversal leaves something wrong that the
reviewer can see.** A fix that made the world consistent reverses into a world that is consistently
wrong, which is a different — and for most reviewers, invisible — problem.

### Known limitation: a reversed diff carries the fix's own explanation

`git show -R` turns the fix's added comments into **deleted** lines, so a reviewer sees
`- # this is the one step that can hang` going away. That is a hint the original reviewer never had,
and it makes seeded cases somewhat easier than the reality they stand in for.

It is not fatal — deleting a safety comment genuinely _is_ a signal a good reviewer should react to
— but it means **recall on this set reads a little high**. Treat the baseline as a regression gate,
which is all it claims to be, and not as a measure of how good the roster is.

## Measured: run-to-run variance is the dominant effect

The first real measurement this suite produced, on `runtime-rename-over-served-file`, three
executions of an identical prompt:

| run | findings                                                                              |
| --- | ------------------------------------------------------------------------------------- |
| 1   | none                                                                                  |
| 2   | **blocking** at `media/video.ts:266` — "reintroducing the Windows EPERM crash (#255)" |
|     | info at `albums/actions.ts:1727` — "always paying the delete-then-rename race window" |
| 3   | none                                                                                  |

Run 2 is a textbook finding: it names the bug, the issue, and both call sites. Runs 1 and 3 say
nothing at all. **Recall on a known-real bug is roughly one run in three**, and that variance is
larger than any prompt change is likely to produce.

The full baseline, once every case was scored at `--repeat 5`:

| specialist     | RECALL (cases) | DETECTED (runs) | FALSE-POS | FP-RUNS |
| -------------- | -------------- | --------------- | --------- | ------- |
| `consistency`  | 0/0            | —               | 0/1       | 0/5 0%  |
| `runtime`      | 1/4            | 10/20 **50%**   | 0/2       | 0/10 0% |
| `test-auditor` | 0/1            | 2/5 **40%**     | 0/0       | —       |

Read the two columns together. `test-auditor` at `0/1` looks blind; at `2/5` it plainly is not. And
**not one run on a clean diff produced a blocking finding** — 0/15. This roster's problem is
consistency, not noise.

Three consequences, and they matter more than any number in the table:

1. **A single run tells you nothing.** `--repeat 1` is for iterating on an `expect` block, never for
   judging a reviewer.
2. **Three repeats may not be enough for a baseline.** At `p ≈ 1/3` per run, majority-of-three is
   itself only about a 1-in-4 chance of scoring `hit` — the case-level outcome is nearly as noisy as
   the run-level one. Record the baseline at `--repeat 5` or higher, and treat a one-case change as
   noise until it repeats.
3. **This is the roster's problem, not the eval's.** A reviewer that finds a real bug a third of the
   time is what the harness has always been; the eval is just the first thing able to say so.

## The baseline

`baseline.json` is committed, and the gate has two halves.

**Case level** (`RECALL`, `FALSE-POS`) is strict: a majority verdict may not go backwards, at all.

**Run level** (`DETECTED`, `FP-RUNS`) is the sensitive half, and it is the one that catches a real
slide. A reviewer going from 2/5 to 0/5 on every case has stopped working, and `RECALL` would not
move by one — both are "miss". It is compared against a **tolerance of two standard errors** of the
baseline rate, because the rate is a sample from a noisy process: at 50% over 20 runs the standard
error alone is ~11%, and a strict comparison would fail on sampling luck. The tolerance is wide on
purpose, and **the way to tighten it is more cases and more repeats** — it shrinks as `sqrt(runs)` —
not a smaller number in the code.

A baseline recorded before detection rates existed makes that half inert. The run says so rather
than reporting a clean pass from a gate that is half switched off.

A harness edit may not lower any specialist's recall or raise its false positives against it. When an edit genuinely improves things, write a new baseline in the same
PR — that makes the improvement a reviewable diff instead of an assertion in a commit message.

Deleting cases is caught: a specialist the baseline covers but the run doesn't score is reported as
a regression, because the cheapest way to make any gate go green is to delete what it measures.

Results are cached on `sha256(case + diff + that specialist's prompt, examples, config, model)`, so
editing one reviewer re-runs only its own cases. Cache lives in `.review-agents/eval-cache/`
(gitignored).

## Cost

Real Claude sessions: roughly `cases × repeats` on a cold cache. The current set is **14 cases**, so
a full `--repeat 3` run is 42 sessions — minutes, not seconds. `--repeat 1` while iterating, the
default 3 before recording a baseline. A single execution is not a measurement: model output varies
run to run, and a gate that flakes is a gate that gets disabled.

Unlike a review, the eval runs its cases one at a time — the concurrency added in
[ADR 0087](../../docs/adrs/0087-specialists-run-concurrently-under-a-cap.md) applies to a review's
roster, not to this loop.

## Current coverage

Fourteen cases: eleven `must-find` — four `runtime`, four `null-result`, two `doc-coherence`, one
`test-auditor` — and three `must-not-find`. That meets the spec's twelve-plus-eight target on the
must-find side and falls well short on must-not-find, which matters more than it sounds: three clean
diffs are a thin basis for the claim that this roster does not cry wolf.

`security`, `spec-adherence` and `contract-guardian` have **no cases at all**. Their rows read `0/0`,
which is honest and is not coverage. `git log` has plenty more `fix(...)` commits to seed from.

**`baseline.json` predates the two new specialists**, so `doc-coherence` and `null-result` have no
recorded floor yet. Re-record it with `--repeat 5 --write-baseline` when you have the sessions to
spare.
