# Development Harness

_How the project's Git hosting, CI, code review, and branch protection combine into a system that catches problems before they land in main. Complements the testing strategy — that doc says what to test; this doc says how you can trust it._

## 1. What we're actually building

The testing strategy earned green builds meaning "it works." The harness makes green builds _mandatory to merge_, catches classes of problems the test suite can't (design drift, style inconsistency, missed test coverage on new code), and does it without you having to remember every check every time.

Three lines of defense, each catching different problems:

1. **Pre-commit / pre-push hooks** — fast, local, prevent obviously broken code from even reaching the remote.
2. **CI checks** — thorough, automatic, prevent broken code from merging. Cover the whole test pyramid from the testing-strategy doc.
3. **Code review agents** — specialized AI reviewers that catch problems no static check or test can: spec drift, subtle design issues, missing test coverage on new logic, schema breaking changes hiding in "additive" PRs.

Plus one meta-line:

4. **Branch protection on `main`** — makes all of the above mandatory. Without this, all the harness work is optional and eventually gets skipped.

## 2. Repository structure

Monorepo, per the testing strategy's recommendation. Layout:

```
marquee/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml               # tests, lint, type-check
│   │   ├── contract-tests.yml   # fast schema validation gate
│   │   ├── code-review.yml      # AI reviewer orchestration
│   │   └── nightly.yml          # fake-vs-real audit, extended e2e
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

**GitHub** — matches your existing pattern from the newsletter project. Free for private repos; features we need (Actions, branch protection, CODEOWNERS, PR reviews) are all included.

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
- **Lint the staged files only**: `eslint` / `ruff` on just what's staged. `lint-staged` handles the file filtering.
- **Type-check** (fast, incremental): `tsc --noEmit` on affected packages via turbo. `mypy` for Python.
- **Commit message format**: enforced by `commitlint`.

If any fail, commit is blocked. `--no-verify` exists for genuine emergencies; don't use it.

### Pre-push (runs on `git push`, budget: 20-30 seconds)

- **Contract validation**: run the JSON schema validators against every checked-in fixture and reference payload. Catches schema drift before CI does. The same suite carries the repo-wide conflict-marker scan — a backstop for the pre-commit check, since that one can be skipped with `--no-verify` and the CI `contract-tests` job runs it unfiltered.
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
pnpm turbo run test:contracts test:unit --filter=...[HEAD^1]
```

The `--filter=...[HEAD^1]` syntax runs turbo tasks only for packages affected by the changes since the previous commit. That's what keeps hooks fast even as the repo grows.

## 5. CI pipeline

Three GitHub Actions workflows, staged by cost and coverage. Every PR blocks on all three passing.

### `contract-tests.yml` — the fastest, most valuable gate

Runs first, in isolation. If contracts are broken, nothing else matters — kill the build fast.

- Validates all JSON schemas parse
- Validates all fixture files against their schemas
- Runs the cross-service contract tests in `contract-tests/`
- Runs any consumer-driven contract tests
- Total budget: **under 60 seconds**

Blocks merge if red.

### `ci.yml` — the main check

Runs on every PR push, in parallel where possible.

Jobs:

1. **lint** — full workspace, all languages
2. **type-check** — full workspace
3. **unit tests** — all Node packages, in parallel via turbo
4. **unit tests (Python)** — nfc-trigger package
5. **integration tests** — all packages, using fakes from `packages/fakes/`
6. **coverage report** — aggregated across packages, posted as PR comment (not gating)
7. **build** — all packages build cleanly

Budget: **under 5 minutes** total on typical PR. Blocks merge if any job fails except coverage.

### `nightly.yml` — the audits

Runs on schedule (2 AM UTC daily) and on-demand.

- **E2E tests**: spins up all services in Docker Compose, exercises the runtime scenarios
- **Fake-vs-real audit**: runs each fake's test suite against the real dependency in a controlled lab environment (needs a spare Hue bridge, or Spotify sandbox tokens, etc.)
- **Dependency audit**: `pnpm audit`, `pip-audit`, alert on new CVEs
- **License audit**: verify no incompatible licenses in the dep tree

Reports findings; doesn't block anything unless there's a security-critical finding, in which case it opens a GitHub issue with `priority:high`.

### `code-review.yml` — the agent gate

Verifies that the pre-push review agent report exists and matches the current commit SHA. Doesn't run agents itself (they ran locally on your workstation via the pre-push hook). Blocks merge if the report is missing or stale — see §6 for how the pre-push hook produces it.

### Caching

Turbo's remote cache configured on GitHub Actions (via the built-in `TURBO_TOKEN` secret) means the second run of a workflow that touches no source is nearly free — most CI time collapses to cache-hits when a PR only touches docs or a single package.

## 6. Code review agents

**The novel piece.** Static checks and tests catch mechanical problems; code review agents catch design problems. Not a replacement for your own review — a collaborator that reads every diff before you do and surfaces things worth thinking about.

Since you've built a multi-agent Claude Code pipeline before, this will be familiar shape: specialized agents with clear responsibilities, an orchestrator that decides who runs, results aggregated for you to act on.

### Philosophy

Three principles that make agent review actually valuable rather than noisy:

1. **Specialists, not generalists.** Each agent has one job and knows one thing deeply. A "review this PR" mega-prompt is useless; a "check that this schema change hasn't broken consumers" prompt with the actual consumer code loaded produces real findings.
2. **Signal over volume.** Every finding an agent posts costs your attention. False positives train you to ignore the tool. Better to have five specialized agents that fire rarely with high-signal comments than one general agent that always writes an essay.
3. **Blocking vs. informational is a real distinction.** Contract-breaking change → blocking. Missing test on new endpoint → blocking. Style suggestion → informational. Agents self-classify; the workflow enforces the classification.

### The reviewer roster

Six specialists, each with a defined scope, prompt, and blocking behavior.

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

### Orchestration

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

### CI enforcement mode

Agents run as a **pre-push hook**. Their findings are written to a report file that gets committed as part of the push; CI verifies the report exists and covers the current commit hash, but doesn't re-run agents itself.

- Setup: `.husky/pre-push` invokes `pnpm run review --ci`. The invocation blocks the push until Claude Code sessions complete.
- Behavior: every push waits for local agents (typical 30–90 seconds for the full six specialists in parallel). Report is committed as `.review-agents/report-<sha>.json`. CI's `code-review.yml` workflow just checks the report is present and matches the pushed SHA.
- Cost: your existing Claude Code subscription; no per-PR API tokens.
- Escape hatch: `--no-verify` bypasses the hook for genuine emergencies. Report absence is caught by CI, so bypassed pushes still fail the check.

This mode trades the "agents ran automatically on the merge machine" property for simplicity — no self-hosted runner to maintain, no runner-inherited auth to manage. If you skip the hook via `--no-verify`, CI catches you, and you either fix the missing report or explicitly acknowledge the bypass.

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

Configured via GitHub's branch protection UI. Settings for `main`:

- ✅ **Require a pull request before merging**
- ✅ **Require approvals**: 1 (you approving your own PR is fine for solo; add more when there's a team)
- ✅ **Dismiss stale pull request approvals when new commits are pushed**
- ✅ **Require review from Code Owners** (uses `.github/CODEOWNERS`; owner is you)
- ✅ **Require status checks to pass before merging**:
  - `contract-tests`
  - `ci / lint`
  - `ci / type-check`
  - `ci / unit-tests`
  - `ci / integration-tests`
  - `ci / build`
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
- `pnpm run test:integration` — integration tests only.
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
- **Agent findings dashboard** (later) — how often each reviewer fires, how often findings are respected vs. overridden. Calibrates prompt quality over time.
- **Flaky test tracker** — CI logs test durations and failure rates per test. Nightly workflow flags anything with >2% failure rate for investigation.
- **Cache hit rate** — turbo's cache hit percentage. If it drops below 50%, something's wrong with the cache config.
- **Prompt regression signals** — periodic re-benchmarks in `review-agents/eval/` catch cases where a prompt change degrades finding quality. Not urgent early; nice to have once agents have been running for a month.

None of these need dashboards early on. Log to files, spot-check periodically, revisit if signals stay noisy.

Ongoing costs: Claude Code subscription for local runs (already paid); some GitHub Actions minutes for CI (mostly free on private repos under limits). No per-PR API token costs unless you deliberately run agents outside the subscription flow.

## 12. Iteration — how the harness evolves

The harness isn't a set-and-forget artifact. Two rules for its evolution:

**Add checks when a bug ships.** Every escaped defect should either become a test (in the codebase) or a reviewer rule (in the harness). This is how the pyramid grows in the right places — real bugs shape the checks, not theoretical ones.

**Delete checks when they generate more noise than signal.** A reviewer that fires often and is usually wrong is worse than no reviewer. Track the ratio; retire reviewers or refine prompts when the ratio goes bad.

Neither is retrospective work; both happen in the PR that fixes the bug or refines the process. Small, continuous, no dedicated meetings.

## 13. First-week concrete setup

Order matters. Some things unblock others.

1. **Create the GitHub repo.** Private. Add `.gitignore`, `README.md` stub, LICENSE.
2. **Configure branch protection on `main`.** Full settings from §7. Do this before writing any code — otherwise you'll push directly and lose the discipline.
3. **Scaffold the monorepo.** pnpm-workspace.yaml, turbo.json, package.json, tsconfig.base.json.
4. **Set up Husky + lint-staged + commitlint.** Pre-commit and pre-push hooks per §4.
5. **First empty package**: `packages/contracts/`. Add `palette-payload.schema.json` from the integration contract doc. Configure schema-to-typescript codegen. Now `contracts` exports a `PalettePayload` type.
6. **First CI workflow**: `contract-tests.yml`. Validates schemas parse. Green build achieved.
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
- You open a PR; contract-tests block within 60 seconds if you've broken the API surface; CI runs in parallel.
- Reviewer agents post findings; you address the ones that matter, learn from the ones that don't.
- Green build; you approve; squash-merge. Main is now that much better.
- Nightly audit runs; catches drift you didn't see.
- Bugs escape occasionally; each one becomes a test or a reviewer rule.

None of these steps require you to remember to run anything. That's what the harness earns.
