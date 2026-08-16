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

Verifies that the pre-push review agent report exists and matches the current commit SHA. Doesn't run agents itself (they ran locally on your workstation via the pre-push hook). Blocks merge if the report is missing or stale — see §6 for how the pre-push hook produces it.

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

**The novel piece.** Static checks and tests catch mechanical problems; code review agents catch design problems. Not a replacement for your own review — a collaborator that reads every diff before you do and surfaces things worth thinking about.

Since you've built a multi-agent Claude Code pipeline before, this will be familiar shape: specialized agents with clear responsibilities, an orchestrator that decides who runs, results aggregated for you to act on.

### Philosophy

Three principles that make agent review actually valuable rather than noisy:

1. **Specialists, not generalists.** Each agent has one job and knows one thing deeply. A "review this PR" mega-prompt is useless; a "check that this schema change hasn't broken consumers" prompt with the actual consumer code loaded produces real findings.
2. **Signal over volume.** Every finding an agent posts costs your attention. False positives train you to ignore the tool. Better to have five specialized agents that fire rarely with high-signal comments than one general agent that always writes an essay.
3. **Blocking vs. informational is a real distinction.** Contract-breaking change → blocking. Missing test on new endpoint → blocking. Style suggestion → informational. Agents self-classify; the workflow enforces the classification.

### The reviewer roster

Eight specialists, each with a defined scope, prompt, and blocking behavior. (Six at the time this section was written; `null-result` and `doc-coherence` were added 2026-08-13 — see the end of the list.)

**Contract Guardian** _(blocking)_

- Watches: `packages/contracts/**`, and any files that import from it
- Job: detect additive vs. breaking schema changes; verify all consumers of a changed schema have corresponding updates
- Prompt loads: the diff, the previous schema, the list of consumers, the current test coverage on the affected boundary
- Blocks: removal or type change of a required field, addition of required field without corresponding consumer updates, enum value removal
- Ignores: field additions with optional/nullable modifiers, comment changes, formatting

**Test Auditor** _(blocking)_

- Watches: all production code changes
- Job: verify new public functions, endpoints, and code paths have corresponding tests
- Prompt loads: the diff, the tests directory of the affected package, the testing strategy doc as reference
- Blocks: new HTTP endpoint without integration test; new pure function of >10 lines without unit test; new state transition without test coverage
- Informational: "consider a property test for X," "this test looks like assertion mirroring"

**Spec Adherence Reviewer** _(informational, with block-on-drift option)_

- Watches: all production code changes
- Job: check that code changes align with the current specs. Flag divergences either as "spec needs updating" or "code is drifting from spec"
- Prompt loads: the diff, the relevant spec files (curator-spec.md if curator/ changed, etc.), the runtime overview
- Behavior: for each divergence, post a comment: "This code adds X, but the spec describes Y. Which should be updated?" Doesn't block by default; you can promote specific findings to blocking via a workflow config.

**Consistency Reviewer** _(informational)_

- Watches: all code changes
- Job: check that new code matches existing patterns for naming, error handling, log format, file structure
- Prompt loads: the diff, a "style guide" excerpt of the affected package's conventions
- Behavior: comments only, non-blocking. Style questions rarely justify blocking a merge on their own; but you'll want to know before merging.

**Runtime Reviewer** _(informational, some blocking)_

- Watches: all Node/Python code changes
- Job: catch runtime issues that pass tests but bite in production — missing error handling, blocking calls in event loops, resource leaks, obvious race conditions
- Blocks: `throw` without try/catch in async chains; database/network calls without timeout; obvious infinite loops in tests
- Informational: potential race conditions, hot-path optimizations

**Security Reviewer** _(blocking on findings)_

- Watches: all changes
- Job: catch the obvious stuff — hardcoded secrets, SQL injection, path traversal, disabled auth, `eval()`, `child_process` with untrusted input
- Prompt loads: just the diff (no context needed for pattern-matching)
- Behavior: any finding blocks. False positive rate needs to stay very low for this to be trusted; use conservative prompts.

**Null-Result Reviewer** _(blocking)_ — _added 2026-08-13, [ADR 0086](../adrs/0086-a-specialist-may-be-given-context-found-by-search.md)_

- Watches: `.github/workflows/**`, `turbo.json`, every `package.json`, test-runner config, `scripts/**`
- Job: one question — **what does this check's output look like when it is silently doing nothing, and is that distinguishable from success?** Nothing else about a workflow is its brief.
- Blocks: a runner that can discover nothing and exit 0; a skip that reads as a pass; a setting dropped before it reaches the process that reads it; a guard removed while what it guarded remains.
- Exists because §11's standing rule was enforced by three bespoke tests guarding three holes that had already opened (#180/#217, #223, #283), and nothing asked the question of a _new_ check.

**Doc-Coherence Reviewer** _(informational)_ — _added 2026-08-13, [ADR 0086](../adrs/0086-a-specialist-may-be-given-context-found-by-search.md)_

- Watches: `docs/**`, any markdown in the tree, and — via `triggerImports` — any source file citing an ADR
- Job: one question — **this change edited a fact; which other copies of that fact are now wrong?**
- Prompt loads: context found by _search_ rather than by glob (`contextRelated`), since the relevant documents are whichever ones mention what the diff touched
- Informational only for now. Promotion to blocking waits on ledger evidence that its precision holds.
- Exists because documentation fact-drift is the highest-frequency escaped class in this repo (#236, #260, #282, four ADR collisions), CLAUDE.md states the rule, and `spec-adherence` only watches code↔spec drift in one direction.

_The roster is eight, not the six this section originally described._

_Context, updated 2026-08-15 ([ADR 0090](../adrs/0090-context-is-selected-by-section-not-by-the-first-16kb.md)):
a specialist's `contextGlobs` / `includePackageSpecs` files are cut to the **sections related to the
change**, not to their first 16KB. Taking the front of `curator-spec.md` gave a reviewer 7% of it and
dropped §8 HTTP API — the part a change to `server.ts` has to be checked against
([#325](https://github.com/dylanleatham/Marquee/issues/325)). Same budget, different sixteen
kilobytes._

### Orchestration

_Updated 2026-08-13, [ADR 0087](../adrs/0087-specialists-run-concurrently-under-a-cap.md):
specialists run **concurrently under a cap** (`REVIEW_CONCURRENCY`, default 3), not one at a time.
The sequential design was deliberate — "gentler on a loaded machine than N concurrent sessions" —
but that argues for a cap rather than a width of one, and the sum of the roster's budgets is why
nobody ran the reviewers in the inner loop this document asks for. `--fast` adds a second tier: only
the triggered blocking specialists, for the mid-session check._

`review-agents/orchestrator.js` runs during the pre-push hook (and from `pnpm run review` locally). It:

1. Reads the PR diff
2. Determines which files changed and which reviewers are relevant (e.g., no need to run Contract Guardian if `packages/contracts/` is untouched)
3. Fires the relevant reviewers in parallel
4. Aggregates findings, groups by file, deduplicates
5. Posts findings as a single PR review with line comments
6. Sets check status based on blocking findings

Individual reviewers are just files:

```
review-agents/
├── orchestrator.js           # decides who runs, aggregates
├── contract-guardian/
│   ├── prompt.md             # system prompt
│   ├── config.json           # blocking rules, model choice
│   └── examples/             # few-shot examples of good and bad findings
├── test-auditor/
│   ├── prompt.md
│   └── ...
└── ... (one dir per reviewer)
```

Adding a new reviewer is: create a directory with a prompt and config, register it in the orchestrator's routing table. That's the pattern.

### Implementation — via Claude Code

**Agents run through Claude Code, which you already have installed and authenticated.** Each specialist is a Claude Code session invoked in headless mode with a specialist system prompt, the relevant context (diff, spec files, related tests), and structured-output requirements.

**Why Claude Code specifically.**

- You already use it, know it, have it set up — zero incremental infrastructure
- Claude via Claude Code has file-reading and command-running capabilities that agents can use judiciously — e.g., the Test Auditor can `pnpm test:unit --filter <pkg>` to verify a test actually runs before commenting on its adequacy
- Cost lives in your existing Claude subscription for local runs; only CI (if you go with Option A) hits API pricing
- Output quality is meaningfully higher than local open models, which matters for the subtle finds — Contract Guardian catching a schema-shape breakage that looks additive on the surface, Spec Adherence Reviewer noticing code drift from an obscure spec section
- Anthropic's own tools are the ones that best understand the schema, format, and structure of Claude's responses; less prompt engineering brittleness

**Shape of each specialist:**

```
review-agents/
├── orchestrator.ts               # decides who runs, invokes claude, aggregates
├── contract-guardian/
│   ├── system-prompt.md          # specialist role, blocking rules, output schema
│   ├── context-loader.ts         # gathers relevant files given a diff
│   └── examples.md               # few-shot: good findings, false positives
├── test-auditor/
│   └── ...
└── (one dir per specialist)
```

Each specialist's `context-loader.ts` decides what to include in Claude Code's context — the diff, plus targeted files (schemas for Contract Guardian, tests + testing-strategy.md for Test Auditor, spec files for Spec Adherence Reviewer). Keeping context focused per specialist is what makes six agents cheaper than one mega-agent, and lets findings stay high-signal.

The orchestrator invokes Claude Code in headless mode per specialist:

```
claude --print --system-prompt-file review-agents/contract-guardian/system-prompt.md \
       --input-file /tmp/pr-context.json
```

Findings return as JSON matching a shared schema (finding severity, file/line, message, suggested fix). Orchestrator aggregates across specialists, dedupes by file+line, posts a single PR review.

**Setup**: nothing new. You already have Claude Code installed. Configure the workspace to know where Claude Code is (`.env` has `CLAUDE_CODE_PATH`, defaulting to your existing binary location).

### CI enforcement mode — designed, then abandoned

> **Superseded. Not what the harness does.** Recorded because the reasoning still explains the
> shape of `--ci`, which survives as a flag. Three of this section's claims were false by the time
> anyone checked ([#330](https://github.com/dylanleatham/Marquee/issues/330) touched the line and
> found them): `.husky/pre-push` says in its own comment that the review agents are **not** run
> there, `.review-agents/` is **gitignored** so no report is ever committed, and the
> `code-review.yml` workflow named below **does not exist**. What is actually true is §4.1's rule —
> the reviewers run **on demand**, and the only thing committed is `review-agents/ledger.jsonl`.

The design was: agents run as a **pre-push hook**, their findings written to a report file committed as part of the push; CI verifies the report exists and covers the current commit hash, but doesn't re-run agents itself.

- Setup: `.husky/pre-push` invokes `pnpm run review --ci`. The invocation blocks the push until Claude Code sessions complete.
- Behavior: every push waits for local agents (typical 30–90 seconds for the full roster in parallel). The report was to be committed alongside the push, and CI's `code-review.yml` workflow would check it is present and matches the pushed SHA.
- Cost: your existing Claude Code subscription; no per-PR API tokens.
- Escape hatch: `--no-verify` bypasses the hook for genuine emergencies. Report absence is caught by CI, so bypassed pushes still fail the check.

It traded the "agents ran automatically on the merge machine" property for simplicity — no self-hosted runner to maintain, no runner-inherited auth to manage. It was dropped because a hook that fires 4–6 real Claude Code sessions makes every push cost minutes; the pre-push hook says so where it explains what it deliberately does not run.

### Local invocation

`pnpm run review` runs the same agents against staged changes, one at a time or in parallel:

- `pnpm run review` — runs the full set
- `pnpm run review --reviewer contract-guardian` — one specialist
- `pnpm run review --explain` — verbose mode showing which context was passed to each specialist (useful for debugging false positives)

Same code path as CI. This is the primary iteration loop during dev — you catch issues locally, address them, then push.

### Failure modes

- **Claude Code not authenticated.** Pre-push hook or workflow fails with a clear message ("Run `claude login`, then retry").
- **A specialist times out.** Each session has a budget — 90 seconds by default, overridable globally
  with `REVIEW_TIMEOUT_MS` and **per specialist** via `timeoutMs` in its `config.json`. The budget
  belongs to the reviewer, not the machine: `runtime` triggers on every source file in the repo and
  needs minutes, while `security` finishes in seconds. On timeout the specialist retries once, then
  its slot is marked "specialist unavailable"; the others still run.

  A **non-blocking** specialist going missing is reported and doesn't gate. A **blocking** one going
  missing means that dimension went unreviewed, so the run is reported as _incomplete_ — the summary
  names the specialists, the clean-review message is suppressed, `--ci` exits non-zero, and the
  report records `silentBlocking`. _(Changed 2026-07-26, [issue #116](https://github.com/dylanleatham/Marquee/issues/116).
  This previously read "doesn't block merge (unavailable ≠ invalid)", which let a run where two
  blocking specialists never started still print "No findings" and "0 blocking". "Didn't review" and
  "reviewed and found nothing" are different claims, and a gate people trust must not conflate them.
  Claude Code being unreachable **entirely** is still a skip, not a gate — that's a harness that
  isn't running, not a review with a hole in it.)_

- **Malformed model output** — _not_ rare in practice. Every specialist's prompt requires a JSON
  findings array, and the contract is placed **after** the diff so it sits closest to generation; a
  reply that still isn't JSON gets one **reformat round** (the specialist translates its own reply,
  no diff attached) before the orchestrator falls back to surfacing the prose as a single
  informational finding. The report records `repaired` and `unformatted` counts so the rate is
  observed rather than assumed. _(Reworked 2026-07-26, [issue #117](https://github.com/dylanleatham/Marquee/issues/117):
  the original text assumed this was rare and that a salvaged reply was good enough. Neither held —
  every specialist with something to say was answering in prose, and a salvaged reply loses file,
  line and severity, so a blocking finding written as a paragraph could not block.)_
- **False positive that keeps blocking a legitimate PR.** Two escape hatches: (a) admin override with labeled comment `override-review:<reviewer-name>`, logged for audit; (b) the reviewer's prompt gets updated in the same PR to fix the false-positive pattern.
- **Workstation offline** (Option A only). Runner is offline; PR waits. If you're away for a while, disable the required check temporarily or manually mark the PR as reviewed.
- **Subscription rate limits.** Very rare in solo dev, but if you hit them, Option B just delays that push; Option A's workflow retries.

### What the agents don't do

- They don't approve merges — humans (you) still hit the button.
- They don't rewrite code — they find and describe issues, they don't fix them.
- They don't participate in discussion threads — one-shot review per PR push.
- They don't have memory across PRs — each PR is a fresh context.
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

- **Per-PR agent runtime** — how long each specialist took. Posted as a PR comment by the orchestrator. Slow specialists suggest either context bloat (too much loaded per prompt) or genuinely hard PRs.
- **Agent findings ledger** — how often each reviewer fires, and how often its findings were right. _(Built 2026-08-13. `pnpm run review --triage` records a verdict per finding into the committed `review-agents/ledger.jsonl`; `pnpm run review:stats` prints per-specialist volume, precision and the repeat-class table. It is the instrument §12's delete rule needs — before it, that rule had never been executable. Design: [harness-self-improvement.md](harness-self-improvement.md) §4.1. Not a dashboard: a JSONL file and a printed table, per the note below about not needing dashboards early.)_
- **Flaky test tracker** — CI logs test durations and failure rates per test. Nightly workflow flags anything with >2% failure rate for investigation.
- **Cache hit rate** — turbo's cache hit percentage. If it drops below 50%, something's wrong with the cache config.
- **Prompt regression signals** — re-benchmarks in `review-agents/eval/` catch cases where a prompt change degrades finding quality. _(Built 2026-08-13, [ADR 0085](../adrs/0085-a-harness-edit-is-validated-against-a-frozen-case-set.md). `pnpm run review:eval` scores every specialist against frozen cases seeded from this repo's own `fix(...)` commits and compares to a committed baseline; a change under `review-agents/` may not lower recall or raise false positives. Two limits to know: it runs **locally only** — a GitHub runner has no `claude` binary or auth, so an eval job in a workflow could never measure anything — which makes this a human discipline rather than an enforced gate; and coverage starts at eight cases, with `security`, `spec-adherence` and `contract-guardian` at zero. See [review-agents/eval/README.md](../../review-agents/eval/README.md).)_

None of these need dashboards early on. Log to files, spot-check periodically, revisit if signals stay noisy.

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

**Delete checks when they generate more noise than signal.** A reviewer that fires often and is usually wrong is worse than no reviewer. Track the ratio; retire reviewers or refine prompts when the ratio goes bad.

Neither is retrospective work; both happen in the PR that fixes the bug or refines the process. Small, continuous, no dedicated meetings.

_Mechanism, 2026-08-14 ([ADR 0089](../adrs/0089-the-retro-proposes-and-a-human-accepts.md)):
`pnpm run review:retro` reads the ledger, the escaped-bug commits, the eval baseline and the case set,
and writes a proposal file to `review-agents/retro/`. It **proposes and never accepts** — a test
asserts it leaves the tree byte-for-byte unchanged — and anything done from its output still has to
pass `pnpm run review:eval`. That is the loop this section describes, with a human holding the accept
step._

_Status note, 2026-08-13: until this date only the first rule had ever run. The second could not be executed at all — the ratio it says to track was recorded nowhere, since reports are per-SHA and gitignored, so every run was amnesiac, and `review-agents/KNOWN-ISSUES.md` tracks harness **defects** rather than finding **quality**. The ledger ([harness-self-improvement.md](harness-self-improvement.md) §4.1) now records it: judge a review with `pnpm run review --triage`, read it back with `pnpm run review:stats`. Two caveats on acting on what it says. First, a precision figure below n=8 is not printed at all, so a reviewer is not "bad" until there is enough evidence to say so. Second, the retirement decision the rule describes still has no safety net — there is no eval gate yet (§4.2), so changing a specialist's prompt in response to what the ledger says is still an unvalidated edit._

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
