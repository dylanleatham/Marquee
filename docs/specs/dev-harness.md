# Development Harness

_How the project's Git hosting, CI, code review, and branch protection combine into a system that catches problems before they land in main. Complements the testing strategy — that doc says what to test; this doc says how you can trust it._

## 1. What we're actually building

The testing strategy earned green builds meaning "it works." The harness makes green builds _mandatory to merge_, catches classes of problems the test suite can't (design drift, style inconsistency, missed test coverage on new code), and does it without you having to remember every check every time.

Three lines of defense, each catching different problems:

1. **Pre-commit / pre-push hooks** — fast, local, prevent obviously broken code from even reaching the remote.
2. **CI checks** — thorough, automatic, prevent broken code from merging. Cover the whole test pyramid from the testing-strategy doc.
3. **Code review agents** — specialized AI reviewers that catch problems no static check or test can: spec drift, subtle design issues, missing test coverage on new logic, schema breaking changes hiding in "additive" PRs.

Plus one meta-line:

4. **Branch protection on `main`** — makes all of the above mandatory. Without this, all the harness work is optional and eventually gets skipped. **This line does not exist today** — protected branches are a paid feature for private repos, so lines 1-3 are held by convention rather than enforced (§7).

## 2. Repository structure

Monorepo, per the testing strategy's recommendation. Layout:

```
marquee/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml               # the PR gate: static, tests, integration, python
│   │   ├── code-review.yml      # AI reviewer orchestration (not built)
│   │   └── nightly.yml          # Windows unit suite; fake-vs-real audit and e2e not built
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── .husky/                       # git hooks
│   ├── pre-commit
│   └── pre-push
├── docs/
│   ├── specs/                    # all the .md specs we've written
│   ├── adrs/                     # architecture decision records
│   └── runbook.md                # how to operate the system
├── packages/
│   ├── contracts/                # JSON schemas + generated types
│   ├── fakes/                    # fake external deps (shared)
│   ├── palette-press/            # library
│   ├── curator/                  # Node service (includes Roadie)
│   ├── hue-conductor/            # Node service
│   ├── backdrop/                 # Node service
│   └── nfc-trigger/              # Python service
├── fixtures/                     # test fixtures (albums, palettes, videos)
├── scripts/                      # dev helpers, local orchestration
├── contract-tests/               # cross-service contract tests
├── e2e/                          # end-to-end tests
├── review-agents/                # code review agent configs + prompts
├── .env.example                  # documented env var shape (no secrets)
├── .gitignore
├── .nvmrc                        # Node version pin
├── package.json                  # workspace root
├── pnpm-workspace.yaml           # or npm workspaces
├── tsconfig.base.json
├── turbo.json                    # or nx.json — orchestrated builds
└── README.md
```

**Package manager**: `pnpm` — faster than npm, better monorepo support than yarn v1, no compatibility issues on Windows. `pnpm-workspace.yaml` handles the packages/ tree cleanly.

**Build orchestrator**: `turbo` — caches per-package builds, only re-runs what changed. For a five-package monorepo, this is the difference between "20-second test loop" and "3-minute test loop."

**Language version pinning**: `.nvmrc` for Node, `pyproject.toml` for Python. CI and pre-commit both consume these. No "works on my machine" drift.

## 3. Git hosting and workflow

**GitHub** — matches your existing pattern from the newsletter project. Free for private repos; Actions, CODEOWNERS and PR reviews are all included. **Branch protection is not** — it needs Pro or a public repo (§7), which this sentence claimed otherwise for the life of the doc. Actions minutes are also capped at 2,000/month on the free plan, which the CI pipeline is now designed around ([ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md)).

**Repo visibility**: private for now. The specs and code are yours; no reason to publish before you're ready.

**Branching model**: trunk-based with short-lived feature branches.

- `main` — always green, always deployable, protected
- `feat/<short-name>` — feature branches, deleted after merge
- `fix/<short-name>` — bug fixes
- `chore/<short-name>` — refactors, dependency bumps, docs
- No long-lived develop / staging / release branches. Overkill for a small team; can be introduced later if needed.

**Commit messages**: Conventional Commits format (`feat: add roadie retry logic`, `fix(conductor): handle bridge disconnect`, `chore(deps): bump fastify`). Enforced by a pre-commit hook. Enables automatic changelog generation later.

**Merge strategy**: squash-merge to main. Each PR becomes one clean commit; main's history reads as a series of features.

**PR sizing**: aim for PRs that could reasonably be reviewed in 10 minutes. If a PR touches more than ~500 lines of production code (excluding generated files, fixtures, and tests), split it. This is a discipline, not an enforced rule.

## 4. Pre-commit and pre-push hooks

Managed by Husky. The goal: never push code that a CI would immediately reject. Fast local feedback prevents the "push, wait 3 minutes, red X" cycle.

### Pre-commit (runs on `git commit`, must be fast: <5 seconds)

- **Conflict markers**: `node scripts/check-conflict-markers.mjs --staged`, and it runs **first** —
  ahead of the formatter. Prettier does not read `<<<<<<< HEAD` as anything but prose, and it
  rewrites a closing marker in markdown into a nested blockquote, which then looks deliberate. Once
  formatted, the evidence is gone. _(Added 2026-07-25, [issue #113](https://github.com/dylanleatham/Marquee/issues/113),
  after a botched resolution shipped both sides of a conflict into `curator-spec.md`.)_
- **Format check**: `prettier --check` on staged files (Node), `black --check` (Python). Auto-fix available via `pnpm run format`.

  > **Note (2026-07-26, [issue #97](https://github.com/dylanleatham/Marquee/issues/97)):** staged-only
  > is why this alone isn't enough. A file nobody happens to stage after a Prettier version or config
  > change stays drifted indefinitely — 28 files had accumulated before anyone ran `validate`. CI now
  > has a **`format`** job running `pnpm run format:check` over the whole tree (§5), and generated
  > files are excluded in `.prettierignore` rather than fought with: the Palette Press goldens are
  > written by their own test as `JSON.stringify(…, null, 2)`, so formatting them just means the next
  > golden refresh reverts it.

- **Lint the staged files only**: `eslint` / `ruff` on just what's staged. `lint-staged` handles the file filtering.
- **Type-check** (fast, incremental): `tsc --noEmit` on affected packages via turbo. `mypy` for Python.
- **Commit message format**: enforced by `commitlint`.

If any fail, commit is blocked. `--no-verify` exists for genuine emergencies; don't use it.

### Pre-push (runs on `git push`, budget: 20-30 seconds)

- **ADR numbering**: `node scripts/check-adr-numbers.mjs`, and it runs **first and unconditionally**
  — outside the affected-only filter below. _(Added 2026-08-13,
  [issue #317](https://github.com/dylanleatham/Marquee/issues/317),
  [ADR 0083](../adrs/0083-an-adr-number-is-checked-against-origin-main-at-push-time.md).)_ An ADR is
  a docs-only change touching no package, so `--filter=...[HEAD^1]` selects nothing and this hook
  used to run **zero** tests on the one push that can introduce a number collision. It also compares
  against the numbers `origin/main` has already published, which no single-branch check can — see
  §5's note on why `test:unit` runs unfiltered for the same reason. Pass `--local` to skip only the
  `origin/main` half when you're offline.
- **Contract validation**: run the JSON schema validators against every checked-in fixture and reference payload. Catches schema drift before CI does. The same suite carries the repo-wide conflict-marker scan — a backstop for the pre-commit check, since that one can be skipped with `--no-verify` and CI's `test:contracts` step (in the **static**
  job) runs it unfiltered.
- **Unit tests** on affected packages via turbo cache. Only re-runs what changed.
- **Type-check** across the full workspace.

If any fail, push is blocked. Same escape hatch.

### Hook setup

`.husky/pre-commit`:

```bash
#!/usr/bin/env sh
node scripts/check-conflict-markers.mjs --staged
pnpm exec lint-staged
pnpm turbo run type-check --filter=...[HEAD^1]
```

`.husky/pre-push`:

```bash
#!/usr/bin/env sh
node scripts/check-adr-numbers.mjs || exit 1
pnpm turbo run test:contracts test:unit --filter=...[HEAD^1]
```

The `--filter=...[HEAD^1]` syntax runs turbo tasks only for packages affected by the changes since the previous commit. That's what keeps hooks fast even as the repo grows — and it is why the ADR check sits **outside** it. A guard for changes that touch no package cannot be selected by a package filter; that is not a tuning detail but the reason four number collisions reached `main` ([ADR 0083](../adrs/0083-an-adr-number-is-checked-against-origin-main-at-push-time.md)). Any future repo-wide guard belongs on the same unfiltered line.

## 5. CI pipeline

Two GitHub Actions workflows, split by **how often they need to run**, not by what they check.
`ci.yml` gates every PR and is priced to run a dozen times a day; `nightly.yml` holds the checks
that are worth having but not worth having within four minutes.

> **2026-08-09** — this section previously described three workflows, with `contract-tests.yml`
> standing alone and a `windows-latest` leg on every PR. That pipeline cost ~21 billable minutes per
> event across nine jobs, against a 2,000-minute monthly allowance it exhausted twice in eleven
> days. [ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md) restructured
> it to four jobs and ~7 minutes; the arithmetic and the tradeoffs are recorded there.
> `packages/curator/test/workflow-cost.test.ts` is the gate that keeps the shape.

### `ci.yml` — the PR gate

Triggers on `pull_request` and `workflow_dispatch`. **Not** on `push: main`: `pull_request` already
builds PR-head merged into the current main base, so a post-merge run re-tests a tree that just went
green. It sets `concurrency.cancel-in-progress`, so pushing three times to a branch runs one suite,
not three.

Four jobs:

1. **static** — `pnpm run format:check`, then a single
   `turbo run lint type-check build test:contracts`. One job rather than five, because GitHub bills
   every job rounded up to a whole minute and each one pays its own `checkout` + `pnpm install`; one
   `turbo run` also shares the `^build` all four tasks depend on. `format:check` is here and not a
   turbo task, which is how 28 files once drifted unnoticed (issue #97). `test:contracts` validates
   that every JSON schema parses, that every checked-in fixture matches its schema, and carries the
   repo-wide conflict-marker scan. Steps after the first run under `if: ${{ !cancelled() }}` so a
   formatting failure doesn't hide a type error.
2. **test:unit** — all Node packages via turbo, on `ubuntu-latest`. This leg also carries the two
   repo-wide guards that have no package of their own, `adr-numbering.test.ts` and
   `workflow-turbo-env.test.ts`, which is why it deliberately does **not** run affected-only
   (`--filter=...[origin/main]`): a docs-only PR changes no package, so the ADR-numbering guard
   would go unrun on exactly the PRs it exists to check.
3. **test:integration** — `turbo run test:integration`. Curator is currently the only package that
   defines the script: it runs the tests that shell out to the **real** ffmpeg/ffprobe rather than a
   faked prober. This leg installs ffmpeg (`apt-get install -y ffmpeg`) and sets
   `MARQUEE_REQUIRE_FFMPEG=1`, which turns a missing binary into a build failure instead of a skip —
   for a long stretch no workflow installed ffmpeg at all, so those tests silently skipped on every
   run and two defects shipped through the gap (#180, #217). The real-binary tests live here rather
   than on `test:unit` so an encode never competes with the rest of the monorepo suite for a 2-core
   runner; that contention once flaked Backdrop's timing-sensitive server/ws tests. `test:unit` still
   runs the same files, where they skip for want of ffmpeg exactly as they did before.
4. **python (stylus)** — `pytest -q`, `ruff check stylus tests`, `mypy stylus`: the same three
   commands as the local loop in `packages/stylus/README.md`. Separate from **static** only because
   it needs a different toolchain (`setup-python`), and folding it in wouldn't save a billable
   minute.

Budget: **~7 billable minutes** per PR event, under 4 minutes of wall-clock. Blocks merge if any job
fails.

**Coverage reporting is not built.** It was specified as a non-gating PR comment and never
implemented; adding it means adding a job, which now costs a measured minute — see the job budget in
`workflow-cost.test.ts` before doing so.

### The kill switch

Every job carries `if: ${{ vars.CI_ENABLED != 'false' }}`. When the Actions allowance runs out
GitHub doesn't queue jobs, it fails them in 2-4 seconds with no logs and emails about each run —
which reads like a broken repo rather than a spent budget. Setting the variable turns those failures
into skips, which neither bill nor notify:

```bash
gh variable set CI_ENABLED --body false   # blown budget: stop the noise
gh variable delete CI_ENABLED             # new month: back to normal
```

Unset is the normal state, and `!= 'false'` reads unset as enabled, so a fresh clone needs no setup.

### `nightly.yml` — the slow lane

Runs on schedule (2 AM UTC daily) and on-demand via `workflow_dispatch`. It skips its own suite when
nothing landed in the last 25 hours, so a quiet weekend costs a checkout rather than a full run.

**Built today:**

- **`test:unit (windows-latest)`** (issue #129) — the Pi is Linux but the workstation is Windows,
  and while CI was Linux-only a POSIX-only path assumption could only be caught by hand. This ran on
  every PR until 2026-08-09; Windows runners bill at **2x** on private repos, which made one job 48%
  of the entire CI bill ([ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md)).
  Nightly keeps the signal at a twelfth of the price, and `workflow_dispatch` lets a path-touching
  PR request it by hand. It doubles as the post-merge canary that dropping the `push: main` trigger
  gave up, since it runs the whole `test:unit` graph against `main`.

  The leg bounds process spawning from both directions (issues #131, #156) — parallel package tasks
  each spawn their own vitest fork pool, and on a 4-core Windows runner that got a worker killed
  mid-run with `STATUS_DLL_INIT_FAILED`. Across packages, turbo runs at `--concurrency=1`; within a
  package, `VITEST_MAX_FORKS`/`VITEST_MIN_FORKS` cap vitest's own pool at 1. It isn't a speed trade:
  serialized, the whole graph ran _faster_ (43.3s vs 48.5s) with 32% less system time.

  The env-var half only works because `turbo.json` **declares** those two names on the `test:unit`
  task. Turbo runs in `envMode: strict` and silently drops anything undeclared, which is exactly how
  the setting sat inert from the day it was added until issue #223 — the workflow said the pool was
  capped and it never was. Any variable a workflow sets on a turbo step needs a matching declaration
  in `turbo.json`; `packages/curator/test/workflow-turbo-env.test.ts` fails the build if one is
  missing.

**Specified, not built** — each is a job, and jobs now have a measured price:

- **E2E tests**: spins up all services in Docker Compose, exercises the runtime scenarios
- **Fake-vs-real audit**: runs each fake's test suite against the real dependency in a controlled lab environment (needs a spare Hue bridge, or Spotify sandbox tokens, etc.)
- **Dependency audit**: `pnpm audit`, `pip-audit`, alert on new CVEs
- **License audit**: verify no incompatible licenses in the dep tree

Those would report findings rather than block, opening a `priority:high` issue on a security-critical
result.

### `code-review.yml` — the agent gate

> **Never built, and superseded.** `.github/workflows/` contains `ci.yml` and `nightly.yml`; there
> is no `code-review.yml`. The gate it describes cannot exist either, because the report it would
> check is gitignored and the pre-push hook does not run the agents. The reviewers run **on demand**
> (§6), and nothing about a run is committed.

The design was: verify that the pre-push review agent report exists and matches the current commit SHA. It would not run agents itself (they ran locally on your workstation via the pre-push hook), and would block merge if the report were missing or stale.

### Caching

**Not configured.** This section long claimed that Turbo's remote cache was set up on Actions via a
`TURBO_TOKEN` secret; it never was, and the claim survived unchallenged for the life of the doc —
the kind of spec-that-lies this repo tries not to keep.

It was reconsidered under
[ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md) and deliberately
left off. GitHub's Actions cache is scoped so a branch can read its own caches and the default
branch's; with no workflow running on `main` any more, nothing populates the default-branch cache,
so every PR would start cold. Warming it would mean paying for a `main` run that costs more than the
cache saves. Revisit if a `main` trigger ever comes back, or if a remote cache backend
(Vercel or self-hosted) is set up — that one isn't branch-scoped and would work today.

## 6. Code review agents

**Static checks and tests catch mechanical problems; a reviewer that reads the diff catches design
problems.** Not a replacement for your own review — a collaborator that reads every diff before you
do and surfaces things worth thinking about.

> **Rewritten 2026-08-16
> ([ADR 0092](../adrs/0092-the-harness-is-three-reviewers-and-one-command.md)).** This section
> previously specified eight specialists, three-sample runs, a committed findings ledger, a frozen
> eval set and a retro command — roughly ten minutes and 24 Claude sessions per review, plus four
> commands to run afterwards. It was cut to three reviewers and one command. The reasoning, and what
> was given up, is in the ADR; the deleted machinery is in git history at `af1dde0`.

### Philosophy

1. **Specialists, not generalists.** Each reviewer has one job and knows one thing deeply. A "review
   this PR" mega-prompt is useless; a "check that this schema change hasn't broken consumers" prompt
   with the actual consumer code loaded produces real findings.
2. **Signal over volume.** Every finding costs your attention. False positives train you to ignore
   the tool.
3. **Only encode what a general-purpose reviewer can't know.** Generic correctness, security and
   style review is a solved, maintained thing (`/code-review`, `/security-review`). A bespoke
   reviewer has to earn its minute by knowing something specific to this repo.
4. **Blocking vs. informational is a real distinction.** Missing test on a new endpoint → blocking.
   Spec drift → informational, because the right resolution is a conversation.

### The reviewer roster

Three, each built from a class of defect that escaped this repo more than once.

**Null-Result Reviewer** _(blocking)_ — added 2026-08-13

- Watches: `.github/workflows/**`, `turbo.json`, every `package.json`, test-runner config, `scripts/**`
- Job: one question — **what does this check's output look like when it is silently doing nothing,
  and is that distinguishable from success?** Nothing else about a workflow is its brief.
- Blocks: a runner that can discover nothing and exit 0; a skip that reads as a pass; a setting
  dropped before it reaches the process that reads it; a guard removed while what it guarded remains.
- Exists because §11's standing rule was enforced by three bespoke tests guarding three holes that had
  already opened (#180/#217, #223, #283), and nothing asked the question of a _new_ check.

**Test Auditor** _(blocking)_

- Watches: all first-party source, including `review-agents/` and `scripts/`
- Job: verify new public functions, endpoints, components and code paths have tests
- Blocks: new HTTP endpoint without integration test; new pure function of >10 lines without unit
  test; new state transition without coverage
- It is what CLAUDE.md's "new surface ⇒ test in the same change" rule leans on

**Spec Adherence Reviewer** _(informational)_

- Watches: first-party source **and** `docs/**`, plus any file citing an ADR
- Job: one question — **this change edited a fact or a behaviour; what else now disagrees?** Both
  directions of code ↔ spec drift, and doc ↔ doc drift.
- Loads: the specs for the changed package(s), plus context found by _search_ (`contextRelated`),
  since the documents that repeat a fact are whichever ones mention what the diff touched
- Informational by design: the fix is usually "update the spec", and that is the author's call
- The doc↔doc half was a separate `doc-coherence` reviewer from 2026-08-13 to 2026-08-16. It was
  merged here because both halves ask the same question and neither needs its own session. Fact-drift
  is the highest-frequency escaped class in this repo (#236, #260, #282, four ADR collisions).

_Retired 2026-08-16:_ `contract-guardian` (never fired — its trigger was `packages/contracts/**`
alone, and its recall measured 0/1), `consistency` (style drift, unmeasurable and low-value),
`runtime` (missing timeouts/leaks — measured 1/4, and `/code-review` covers the same ground),
`security` (superseded by `/security-review`). Their prompts are in git history if a class comes
back.

### Orchestration

`review-agents/orchestrator.mjs` runs from `pnpm run review`. It reads the diff, decides which
reviewers are triggered by the changed files, runs them **concurrently under a cap**
(`REVIEW_CONCURRENCY`, default 3 — [ADR 0087](../adrs/0087-specialists-run-concurrently-under-a-cap.md)),
parses each reply into findings, dedupes by file+line+message, and prints them. With three reviewers
and a cap of three, a review is one round — 1-5 minutes, set by the slowest reviewer
(`spec-adherence`, which reads the most context).

Each reviewer is a directory of three files — `config.json`, `system-prompt.md`, `examples.md` — and
the orchestrator auto-discovers any directory containing a `config.json`. There is no routing table
to register in. Full detail: [review-agents/README.md](../../review-agents/README.md).

**One run per reviewer.** From 2026-08-13 to 2026-08-16 a review ran each reviewer three times and
unioned the findings, because measured per-run detection was 33–80%
([ADR 0088](../adrs/0088-a-review-samples-each-specialist-and-unions-the-findings.md)). The
measurement stands; the default does not. Tripling the token cost and the wall clock of every review
to recover findings at the margin is the wrong trade for a solo repo whose actual failure mode was
that the reviewers felt too expensive to run at all. A review is a signal, not a proof — if a change
warrants more confidence, run it twice.

_Context, 2026-08-15 ([ADR 0090](../adrs/0090-context-is-selected-by-section-not-by-the-first-16kb.md)):
a reviewer's `contextGlobs` / `includePackageSpecs` files are cut to the **sections related to the
change**, not to their first 16KB. Taking the front of `curator-spec.md` gave a reviewer 7% of it and
dropped §8 HTTP API — the part a change to `server.ts` has to be checked against
([#325](https://github.com/dylanleatham/Marquee/issues/325)). Same budget, different sixteen
kilobytes._

### Invocation

```bash
pnpm run review                          # this branch vs origin/main
pnpm run review --staged                 # staged changes only
pnpm run review --reviewer null-result   # one reviewer
pnpm run review --explain                # print the context each reviewer got
pnpm run review --ci                     # exit 1 on blocking findings
```

Run it in the inner loop, before the first commit. It is deliberately **not** in `pre-push`: a hook
that fires real Claude Code sessions makes every push cost minutes, and this repo already has a
`--no-verify`-shaped hole waiting for exactly that. A Stop hook in `.claude/` mentions the reviewers
when reviewable source has changed and they never ran; it never blocks.

### Failure modes

- **Claude Code not authenticated or not installed.** The run **skips without blocking** —
  unavailable ≠ invalid. That is the harness not running at all, which is visible; it is not the same
  as a review that silently covered less than it claims.
- **A reviewer times out.** Each session has a budget — 90 seconds by default, overridable globally
  with `REVIEW_TIMEOUT_MS` and **per reviewer** via `timeoutMs` in its `config.json`. The budget
  belongs to the reviewer, not the machine. On timeout it retries once, then its slot is marked
  unavailable; the others still run.

  A **non-blocking** reviewer going missing is reported and doesn't gate. A **blocking** one going
  missing means that dimension went unreviewed, so the run is reported as _incomplete_ — the summary
  names it, the clean-review message is suppressed, `--ci` exits non-zero, and the report records
  `silentBlocking`. _(2026-07-26, [issue #116](https://github.com/dylanleatham/Marquee/issues/116):
  this previously read "doesn't block merge (unavailable ≠ invalid)", which let a run where two
  blocking reviewers never started still print "No findings" and "0 blocking". "Didn't review" and
  "reviewed and found nothing" are different claims.)_

- **Malformed model output** — _not_ rare in practice. Every prompt requires a JSON findings array,
  and the contract is placed **after** the diff so it sits closest to generation; a reply that still
  isn't JSON gets one **reformat round** (the reviewer translates its own reply, no diff attached)
  before the orchestrator falls back to surfacing the prose as a single informational finding. The
  raw reply is written to `.review-agents/` so the failure is diagnosable.
  _(2026-07-26, [issue #117](https://github.com/dylanleatham/Marquee/issues/117): the original text
  assumed this was rare and that a salvaged reply was good enough. Neither held — a salvaged reply
  loses file, line and severity, so a blocking finding written as a paragraph could not block.)_
- **A false positive you disagree with.** Say so and move on; the bar is "no blocking findings left
  unanswered", not zero findings. If the same wrong finding shows up twice, fix the prompt in the PR
  where it annoyed you.

### What the agents don't do

- They don't approve merges — humans (you) still hit the button.
- They don't rewrite code — they find and describe issues, they don't fix them.
- They don't have memory across runs — each review is a fresh context, and nothing is recorded
  between runs. _(From 2026-08-13 to 2026-08-16 a committed `ledger.jsonl` held triaged verdicts on
  past findings. It was removed with four records in it; see
  [ADR 0092](../adrs/0092-the-harness-is-three-reviewers-and-one-command.md).)_
- They don't replace the testing strategy — they catch problems tests wouldn't have caught anyway.

## 7. Branch protection

> **Status (2026-08-09): none of this is in effect, and none of it can be on the current plan.**
> Both the classic branch-protection API and rulesets return
> `403 Upgrade to GitHub Pro or make this repository public to enable this feature` for
> `dylanleatham/Marquee` — protected branches are a paid feature for private repos. `main` is
> therefore unprotected: nothing requires a PR, nothing requires a status check, and nothing stops a
> direct push. **The git hooks in §4 are the only real gate**, which is why CLAUDE.md says not to
> commit product code straight to `main` — that's a convention held by hand, not an enforced rule.
>
> This section has read as configuration since it was written, and it was aspirational the whole
> time; §1 even calls branch protection the "meta-line" that makes the other three mandatory, which
> means the harness has never had that line. Treat what follows as **the settings to apply if the
> repo ever goes public or onto Pro** — the same two options that would fix the Actions budget
> ([ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md)).

Settings for `main`, once available:

- ✅ **Require a pull request before merging**
- ✅ **Require approvals**: 1 (you approving your own PR is fine for solo; add more when there's a team)
- ✅ **Dismiss stale pull request approvals when new commits are pushed**
- ✅ **Require review from Code Owners** (uses `.github/CODEOWNERS`; owner is you)
- ✅ **Require status checks to pass before merging** (job names as of
  [ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md) — `lint`,
  `type-check`, `build` and `contracts` are steps of `static` now, not checks of their own, and
  `test:unit (windows-latest)` has moved to `nightly.yml` and must **not** be required here):
  - `static`
  - `test:unit`
  - `test:integration`
  - `python (stylus)`
  - `code-review / agents` (blocking reviewers only)
- ✅ **Require branches to be up to date before merging**
- ✅ **Require conversation resolution before merging**
- ✅ **Require signed commits** (optional, but nice practice; requires GPG key setup)
- ✅ **Require linear history**
- ❌ Allow force pushes
- ❌ Allow deletions

Repository admin bypass: on for you (needed for genuine emergency merges), logged.

## 8. Local development experience

The goal: `git clone && pnpm run setup` gets a new environment (or a new laptop) fully ready.

### One-command setup

`scripts/setup.sh`:

- Verifies Node version matches `.nvmrc`
- Verifies Python version
- `pnpm install`
- `python -m venv` for the nfc-trigger package
- Installs Husky hooks
- Runs `.env.example` → `.env` if not present, prompts for missing values
- Runs a smoke test to prove everything's wired

`pnpm run setup` is the entry point.

### One-command dev

`pnpm run dev` — starts every service locally with logs multiplexed. Uses `concurrently` or a small custom script.

Options for what runs:

- Default: all Node services + fakes (no Python, no hardware)
- `--with-nfc`: also spins up nfc-trigger against fake-pn532
- `--with-e2e`: full stack with fake external deps, ready for e2e testing

### One-command test

- `pnpm test` — full test suite. Under 2 minutes.
- `pnpm run test:fast` — unit + contract only. Under 30 seconds.
- `pnpm run test:integration` — integration tests only. Today that means Curator's real-ffmpeg
  tests; needs ffmpeg on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH`), and skips without it unless you set
  `MARQUEE_REQUIRE_FFMPEG=1` as CI does.
- `pnpm run test:e2e` — end-to-end, requires `--with-e2e` dev running.

### Other useful commands

- `pnpm run lint`, `pnpm run type`, `pnpm run format` — obvious
- `pnpm run review` — local code review agents (see §6)
- `pnpm run validate` — pre-flight check that runs everything a PR would need to pass. Slower than pre-commit, faster than CI.
- `pnpm run spec:check` — verify all specs referenced by ADRs exist; verify all code has a spec home.

### The scripts/ directory

Keep local helpers here, not scattered in package.json's `scripts` field. Examples:

- `scripts/setup.sh` — the setup script
- `scripts/gen-schemas.ts` — generate TS types from JSON schemas
- `scripts/gen-python-models.py` — generate Pydantic models from JSON schemas
- `scripts/smoke.ts` — smoke test the whole stack after setup
- `scripts/node-test.mjs` — `node --test`, except that discovering zero tests fails instead of
  passing (§11, [ADR 0066](../adrs/0066-a-test-task-that-runs-no-tests-is-a-failure.md)). Every
  package that drives node's test runner calls this rather than `node --test`.

## 9. Secret management

- `.env.example` in git, documenting every env var with a fake value and a comment
- `.env` gitignored, actual values
- GitHub Actions secrets for CI: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `TURBO_TOKEN`, `HUE_BRIDGE_TEST_KEY` (for nightly fake-vs-real), `BACKDROP_SHARED_SECRET` (test value), `NFC_TRIGGER_SHARED_SECRET` (test value)
- Claude Code handles its own auth via `claude login` on your workstation. Pre-push hook uses that authentication directly. No API keys stored in the repo or in GitHub secrets for review agents.
- Runtime services on hardware read secrets from local config files (`~/curator/config.toml`, etc.), not env vars. Env vars are for dev/CI.
- **No secrets in the repo, ever.** `gitleaks` runs as part of pre-commit and the CI security check to enforce.

## 10. Documentation practices

- **Specs** live in `docs/specs/`. Every service and cross-cutting concern has one. Kept in sync with code; the Spec Adherence Reviewer nags when they drift.
- **ADRs** (Architecture Decision Records) live in `docs/adrs/`. Every significant "we chose X over Y" decision gets one — format: context, decision, consequences. Numbered sequentially, immutable once merged. Superseded by newer ADRs when decisions change; the superseded doc stays as history.
- **README per package**. Standard sections: purpose, install, run, test, contribute.
- **Runbook** (`docs/runbook.md`): how to operate the live system. Troubleshooting, common issues, how to restart services safely.

Every PR that changes behavior should either update a spec or add an ADR (or explicitly note "no doc change needed" with a brief reason). Enforced socially, not mechanically — checking would be too fussy for a solo project.

## 11. Observability of the harness itself

The harness needs its own observability so you can trust it. Signals to surface:

- **Per-reviewer runtime** — the orchestrator prints how long each reviewer took. A slow one suggests
  either context bloat (too much loaded per prompt) or a genuinely hard diff.
- **Flaky test tracker** — CI logs test durations and failure rates per test. Nightly workflow flags anything with >2% failure rate for investigation.
- **Cache hit rate** — turbo's cache hit percentage. If it drops below 50%, something's wrong with the cache config.

None of these need dashboards early on. Log to files, spot-check periodically, revisit if signals stay noisy.

_Measuring the reviewers themselves, 2026-08-13 to 2026-08-16: a committed findings ledger
(`--triage` / `review:stats`) recorded a verdict per finding, and a frozen eval set
(`review:eval`) scored each reviewer's recall against cases seeded from this repo's own `fix(...)`
commits. Both were removed with four ledger records and one baseline recorded — the measurement cost
more attention than the reviewers themselves did. See
[ADR 0092](../adrs/0092-the-harness-is-three-reviewers-and-one-command.md); the code and the case set
are in git history at `af1dde0` if the roster ever grows enough to need them again._

### A check that measures nothing must not report green

The failure this harness keeps having is not a check that breaks — it's a check that goes quiet. It
has happened three times, and each time the green tick was indistinguishable from a real pass:
ffmpeg tests skipping because CI never installed the binary
([#180](https://github.com/dylanleatham/Marquee/issues/180),
[#217](https://github.com/dylanleatham/Marquee/issues/217)); `VITEST_MAX_FORKS` stripped by turbo's
strict env mode so the fork cap never applied
([#223](https://github.com/dylanleatham/Marquee/issues/223)); and `node --test` discovering zero test
files and exiting 0 ([#283](https://github.com/dylanleatham/Marquee/issues/283)).

So the standing rule: **a check that cannot demonstrate it measured something is a failure, not a
pass.** Concretely, today —

- `scripts/node-test.mjs` wraps every `node --test` caller and fails a run that reported `# tests 0`.
  `packages/curator/test/node-test-guard.test.ts` tests that wrapper and also asserts no package.json
  reintroduces a bare `node --test`. See
  [ADR 0066](../adrs/0066-a-test-task-that-runs-no-tests-is-a-failure.md).
- `MARQUEE_REQUIRE_FFMPEG` turns a missing ffmpeg into a hard failure instead of a silent skip on the
  `test:integration` leg (`packages/curator/test/ffmpeg-gate.ts`).
- `packages/curator/test/workflow-turbo-env.test.ts` fails if a workflow sets a variable `turbo.json`
  doesn't declare, since strict env mode would otherwise drop it before the tests saw it.

When you add a check, ask what its output looks like when it is silently doing nothing. If that's the
same as success, the check isn't finished.

Ongoing costs: Claude Code subscription for local runs (already paid); some GitHub Actions minutes for CI (mostly free on private repos under limits). No per-PR API token costs unless you deliberately run agents outside the subscription flow.

## 12. Iteration — how the harness evolves

The harness isn't a set-and-forget artifact. Two rules for its evolution:

**Add checks when a bug ships.** Every escaped defect should either become a test (in the codebase) or a reviewer rule (in the harness). This is how the pyramid grows in the right places — real bugs shape the checks, not theoretical ones.

**Delete checks when they generate more noise than signal.** A reviewer that fires often and is
usually wrong is worse than no reviewer.

Neither is retrospective work; both happen in the PR that fixes the bug or refines the process. Small, continuous, no dedicated meetings.

**And a third, learned the expensive way: the machinery that governs a check must cost less than the
check.** _(2026-08-16, [ADR 0092](../adrs/0092-the-harness-is-three-reviewers-and-one-command.md).)_
Between 2026-08-13 and 2026-08-16 the delete rule above acquired an apparatus to execute it — a
committed ledger of judged findings, a frozen eval set, a baseline, a retro command, and about 1,900
lines of code with 1,500 lines of tests. Three days later it held four records and had never changed
a decision, while the reviewers it measured had grown to eight specialists sampled three times each:
ten minutes and 24 Claude sessions per review, which is a review nobody runs. The apparatus was
removed and the roster cut to three. If the roster ever grows past what one person can hold in their
head, re-read that history before rebuilding it — the code is at `af1dde0`.

Applied to this section itself: the rules here should be executable by someone who has read only
CLAUDE.md. Anything that needs a second document to explain when to run it is a candidate for
deletion, not for a third document.

## 13. First-week concrete setup

Order matters. Some things unblock others.

1. **Create the GitHub repo.** Private. Add `.gitignore`, `README.md` stub, LICENSE.
2. **Configure branch protection on `main`.** Full settings from §7. Do this before writing any code — otherwise you'll push directly and lose the discipline. (Historical: this step was never completed and could not have been — see the status note on §7.)
3. **Scaffold the monorepo.** pnpm-workspace.yaml, turbo.json, package.json, tsconfig.base.json.
4. **Set up Husky + lint-staged + commitlint.** Pre-commit and pre-push hooks per §4.
5. **First empty package**: `packages/contracts/`. Add `palette-payload.schema.json` from the integration contract doc. Configure schema-to-typescript codegen. Now `contracts` exports a `PalettePayload` type.
6. **First CI workflow**: `contract-tests.yml`. Validates schemas parse. Green build achieved.
   (Historical: that workflow was folded into `ci.yml`'s **static** job on 2026-08-09 —
   [ADR 0064](../adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md). This list
   records the bootstrap order that was actually followed, not the layout to build today.)
7. **Add `ci.yml`**: lint, type-check, empty test suite. Green build extended.
8. **First code review agent**: Contract Guardian. Its whole job at this point is "the contracts package changed — did we test it?" Baby steps. Wire it into the pre-push hook + `code-review.yml` report check.
   (Historical: the second half never happened. `code-review.yml` was never built and the pre-push
   hook deliberately does not run the agents — see §5 and the superseded CI-enforcement block in
   §12. The reviewers run on demand.)
9. **`packages/palette-press/` scaffolded.** Test infra, first fixture album, first golden test. Now you have a real thing to test and a real thing to review.

By end of week one: a repo where a PR touching `packages/contracts/` triggers the Contract Guardian, contract validation runs, and everything else fails cleanly because it's empty. That's a working harness. Everything else is filling in.

## 14. What this harness deliberately isn't

- Not a CI matrix across many Node versions. Pin one; upgrade deliberately.
- Not multi-region. Everything runs where you are.
- Not blue/green deployment. It's a home project on a Pi.
- Not chaos-monkey-style failure injection. Add later if useful; not now.
- Not sub-second CI. If it takes 3 minutes, that's fine — that's a coffee break, not a workflow disruption.
- Not perfect isolation between packages. `turbo` and `pnpm` handle this well enough; formal isolation adds complexity for little gain at this scale.
- Not a mandatory review from a human when the agents pass. You're the only human here; agents are your first-line review.

## 15. What this enables

With the harness in place, working on this project should feel like:

- You open a feature branch, write code with fast-feedback loops (type-check on save, `pnpm run test:fast` between changes).
- You commit; pre-commit hook keeps garbage out.
- You push; pre-push hook keeps larger garbage out.
- You open a PR; the four CI jobs run in parallel and settle in under four minutes, with the **static** job blocking within about ninety seconds if you've broken the API surface, formatting, or types.
- Reviewer agents post findings; you address the ones that matter, learn from the ones that don't.
- Green build; you approve; squash-merge. Main is now that much better.
- Nightly audit runs; catches drift you didn't see.
- Bugs escape occasionally; each one becomes a test or a reviewer rule.

None of these steps require you to remember to run anything. That's what the harness earns.
