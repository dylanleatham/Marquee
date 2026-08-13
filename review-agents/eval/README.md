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

### Known limitation: a reversed diff carries the fix's own explanation

`git show -R` turns the fix's added comments into **deleted** lines, so a reviewer sees
`- # this is the one step that can hang` going away. That is a hint the original reviewer never had,
and it makes seeded cases somewhat easier than the reality they stand in for.

It is not fatal — deleting a safety comment genuinely _is_ a signal a good reviewer should react to
— but it means **recall on this set reads a little high**. Treat the baseline as a regression gate,
which is all it claims to be, and not as a measure of how good the roster is.

## The baseline

`baseline.json` is committed. A harness edit may not lower any specialist's recall or raise its
false positives against it. When an edit genuinely improves things, write a new baseline in the same
PR — that makes the improvement a reviewable diff instead of an assertion in a commit message.

Deleting cases is caught: a specialist the baseline covers but the run doesn't score is reported as
a regression, because the cheapest way to make any gate go green is to delete what it measures.

Results are cached on `sha256(case + diff + that specialist's prompt, examples, config, model)`, so
editing one reviewer re-runs only its own cases. Cache lives in `.review-agents/eval-cache/`
(gitignored).

## Cost

Real Claude sessions, run serially: roughly `cases × repeats` sessions on a cold cache. The current
set is 8 cases, so a full `--repeat 3` run is 24 sessions — minutes, not seconds. `--repeat 1` while
iterating, the default 3 before recording a baseline. A single execution is not a measurement: model
output varies run to run, and a gate that flakes is a gate that gets disabled.

## Current coverage

Eight cases: five `must-find` (four `runtime`, one `test-auditor`) and three `must-not-find`. That is
short of the twelve-plus-eight the spec asks for, and the gap is concentrated in `security`,
`spec-adherence` and `contract-guardian`, which have **no cases at all** — their rows will read
`0/0`, which is honest but is not coverage. `git log` has plenty more `fix(...)` commits to seed
from.
