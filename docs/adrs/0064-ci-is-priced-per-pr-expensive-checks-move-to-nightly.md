# ADR 0064 — CI is priced per PR; expensive checks move to nightly

- **Status:** Accepted
- **Date:** 2026-08-09
- **Supersedes** the three-workflow pipeline described in
  [dev-harness §5](../specs/dev-harness.md), and moves the `windows-latest` leg added for
  [#129](https://github.com/dylanleatham/Marquee/issues/129) off the PR path. The mitigations that
  leg carries for [#131](https://github.com/dylanleatham/Marquee/issues/131) /
  [#156](https://github.com/dylanleatham/Marquee/issues/156) / #223 move with it, unchanged.

## Context

The GitHub Actions allowance for a private repo on the free plan is **2,000 minutes a month**. This
repo was spending roughly **15,000**, and had exhausted the allowance twice in eleven days
(2026-07-29 and 2026-08-08). When the allowance is gone GitHub does not queue jobs — it fails every
one of them in 2-4 seconds with no logs, and emails about each failed run. So the same problem
presented twice: as a bill, and then as a repo that looks catastrophically broken and floods the
inbox.

Measured over the 100 runs in the two days to 2026-08-09, one PR or push event cost about **21
billable minutes** across nine jobs:

| Job                                                                  | Wall-clock  | Billed          |
| -------------------------------------------------------------------- | ----------- | --------------- |
| `test:unit (windows-latest)`                                         | ~250s       | 5 × **2x** = 10 |
| `test:unit (ubuntu-latest)`                                          | ~147s       | 3               |
| `type-check`                                                         | ~64s        | 2               |
| `build`, `test:integration`, `format`, `lint`, `python`, `contracts` | 20–53s each | 1 each = 6      |

No single job was misbehaving. The cost was four structural habits, each defensible on its own:

1. **`pull_request` and `push: branches: [main]` on the same workflow.** `pull_request` already
   builds PR-head merged into the current main base, so the post-merge run re-tested a tree that had
   just gone green. 52 of the 100 runs were that duplicate.
2. **No `concurrency` group.** Three pushes to a branch inside a minute ran three full suites to
   completion; only the last one's answer was ever read. Three merges to `main` inside 19 seconds on
   2026-08-08 did exactly this.
3. **A `windows-latest` leg on every PR.** Windows bills at 2x on private repos, so one job was 10
   of the 21 minutes — **48% of the entire bill**, more than every other job combined.
4. **Five jobs where one would do.** GitHub rounds every job up to a whole billable minute, and each
   job pays its own `checkout` + `pnpm install` (~25s). `lint`, `type-check`, `build`, `format` and
   `contracts` together did about 90 seconds of real work and cost six minutes. `lint` is the
   sharpest case: every package's lint script is `echo "(no linter configured yet)"`, so a whole
   runner-minute bought nine echoes.

None of this is visible as a failure. A green workflow that costs too much stays green.

## Decision

**`ci.yml` is what gates a PR, and is priced to run a dozen times a day. `nightly.yml` is where
checks that are valuable but not urgent go, and is priced to run once.**

- `ci.yml` triggers on `pull_request` and `workflow_dispatch` only. The `push: branches: [main]`
  trigger is gone.
- `ci.yml` sets `concurrency: { group: ci-<ref>, cancel-in-progress: true }`. With `main` off the
  trigger list there is no ref left where a cancelled run loses information.
- `contract-tests.yml` is deleted. Its work is one step of the new `static` job.
- `static` runs `format:check` and then a single `turbo run lint type-check build test:contracts`,
  which shares the `^build` all four depend on rather than rebuilding it per job. Steps after the
  first use `if: ${{ !cancelled() }}` so consolidating jobs doesn't also consolidate the feedback.
- `test:unit` (Linux) and `test:integration` stay separate jobs. Merging them saves nothing —
  1 + 3 rounds the same as 4 — and would put a real ffmpeg encode back in contention with the
  monorepo suite on a 2-core runner, which is what once flaked Backdrop's server/ws tests.
- The Windows `test:unit` leg moves to `nightly.yml`, on a 02:00 UTC schedule plus
  `workflow_dispatch`. It skips itself when nothing landed in the last 25 hours.
- Every job carries `if: ${{ vars.CI_ENABLED != 'false' }}`.

A PR event is now **four jobs and about seven billable minutes**, down from nine and twenty-one.

### The kill switch

`vars.CI_ENABLED` exists for the failure mode, not the bill. When the allowance is spent, setting it
turns every job from a 4-second red failure into a skip — which neither bills nor sends mail:

```bash
gh variable set CI_ENABLED --body false
```

Unset is the normal state and `!= 'false'` reads unset as enabled, so nothing needs configuring on a
fresh clone. The gate is per-job rather than workflow-level because a skipped _job_ still reports a
conclusion, so the PR's checks list says "skipped" instead of hanging on a check that never arrives.

## Consequences

**Windows breakage is found the next morning, against a day of commits, rather than on the PR that
caused it.** This is the real cost of the decision and it is not free — a bisect across ~12 merges
is meaningfully worse than one red check. Three things make it acceptable: the class is narrow (path
resolution, per #129), the workstation is Windows so the developer runs the suite there constantly
anyway, and `workflow_dispatch` lets a path-touching PR request the leg by hand before merging.

**The nightly Windows run doubles as the post-merge canary** that dropping `push: main` gave up,
since it runs the whole `test:unit` graph against `main`. The case it covers — two PRs green apart
and broken together — also self-heals quickly, because the next PR opened after a bad merge is built
against the new base.

**Turbo remote caching remains unconfigured**, contrary to what dev-harness §5 has long claimed. It
was considered here and rejected for now: GitHub's Actions cache is scoped so that a branch can read
its own caches and the default branch's, and with no workflow running on `main` there is nothing to
populate the default-branch cache. Restoring it would mean paying for a `main` run to warm a cache
that saves less than the run costs. Revisit if a `main` trigger ever returns.

**Affected-only test runs (`turbo run test:unit --filter=...[origin/main]`) were rejected outright.**
Two repo-wide guards — `adr-numbering.test.ts` and `workflow-turbo-env.test.ts` — live inside
`packages/curator` because the ADRs and the workflows have no package of their own. A docs-only PR
changes no package, so an affected-only filter would run nothing at all, and the ADR-numbering guard
would go unrun on precisely the PRs it exists to check. A gate that silently skips itself is the
failure mode this repo keeps rediscovering (#180, #217, #223); trading correctness for minutes there
is the wrong trade.

**The four habits above are now a test**, `packages/curator/test/workflow-cost.test.ts`. It fails on
a PR-triggered workflow that also triggers on push, that lacks `cancel-in-progress`, that puts a
Windows or macOS runner on the PR path, that fans a PR event out past five jobs, or that adds a job
without the `CI_ENABLED` gate. This is the "close the blind spot" rule from the bug-fix workflow:
the overspend was silent while it accrued, so the guard has to fire at the moment a job is added
rather than at the end of the month.

**Seven minutes an event is still not comfortably inside 2,000/month.** At the observed rate of
~12 PR events a day it works out to roughly 2,500 minutes plus ~300 for the nightly — an 82%
reduction that lands close to, but not under, the line. Closing the remainder is not an engineering
problem: making the repo public gives unlimited Actions minutes, and GitHub Pro (3,000 minutes) is
$4/month. Both are outside the scope of this ADR and left to the maintainer.
