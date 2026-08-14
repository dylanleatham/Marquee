# Harness self-improvement

How the review harness learns. Extends [dev-harness.md](dev-harness.md) §6 (the reviewer roster),
§11 (observability of the harness itself) and §12 (iteration) — read those first; this document
does not repeat them.

Status: **Phase 1 built (2026-08-13); Phases 2–6 proposed.** Sections 1–5 are the design; §6 is the
implementation plan and carries the per-phase status; §7 records what is deliberately out of scope.

§4.1 (the ledger) describes shipped behaviour. **§4.2–§4.6 do not** — nothing there is enforced yet,
and in particular there is still no eval gate, so an edit to a specialist's prompt is still an
unvalidated change.

---

## 1. The problem: §12 is a rule the harness cannot execute

dev-harness §12 states two rules for evolving the harness:

> **Add checks when a bug ships.** … **Delete checks when they generate more noise than signal.**
> A reviewer that fires often and is usually wrong is worse than no reviewer. Track the ratio;
> retire reviewers or refine prompts when the ratio goes bad.

The first rule works — RA-1 through RA-5 in [KNOWN-ISSUES.md](../../review-agents/KNOWN-ISSUES.md)
are each an escaped defect that ended as a regression test, which is the rule working exactly as
written.

The second rule had never once been executed, and could not be. **The ratio was not tracked, and
nothing in the harness was capable of tracking it.** Every run writes
`.review-agents/report-<sha>.json` and that directory is gitignored, so each run was amnesiac: there
was no record of what a specialist said last week, whether it was right, or whether it had said the
same wrong thing five times. `KNOWN-ISSUES.md` is a hand-maintained substitute that tracks _harness
bugs_ — it has never held a single entry about _finding quality_, because no instrument existed that
would produce one.

_Phase 1 (§6) closed this on 2026-08-13: the ledger is that instrument. The rest of this section
describes the state it was built to fix, and stays in the past tense on purpose — the argument for
§4.2–§4.6 is the same argument, and it is still open._

That has a second consequence, worse than the first. Because finding quality is unmeasured, every
edit to a specialist's `system-prompt.md`, `examples.md` or `config.json` ships unvalidated. The
prompt-ordering fix in RA-4 was a good change; we know that from reasoning about it, not from
measuring it. dev-harness §11 already names the missing piece —

> **Prompt regression signals** — periodic re-benchmarks in `review-agents/eval/` catch cases where
> a prompt change degrades finding quality.

— and `review-agents/eval/` still does not exist. **This half is unfixed.** The ledger now says
whether a reviewer's findings were right; nothing says whether an edit to that reviewer made it
better, which is a different question and the one Phase 2 answers.

So the harness had an "add" rule with a mechanism and a "delete" rule without one, and no way to
tell a prompt improvement from a prompt regression. This document builds the missing half.

### 1.1 A third gap, found by reading the escape history

Taking every `fix(...)` commit on `main` and asking _which reviewer should have caught this_
sorts the escapes into classes. Two large classes have no reviewer at all:

**Documentation fact-drift — the highest-frequency class.** Four ADR number collisions
([#151](https://github.com/dylanleatham/Marquee/issues/151),
[#267](https://github.com/dylanleatham/Marquee/issues/267),
[#316](https://github.com/dylanleatham/Marquee/issues/316), and the fourth created by the renumber
that fixed the third); `docs(runbook): the Pi 5's address lives in three places, not two` (#260),
which landed after #243 had already asserted it lived in _two_; `fix(curator): point the Discogs
comments at ADR 0017, not 0016` (#236); `chore(docs): delete the stale duplicate spec tree at
files/` (#221); `docs(dev-harness): §7 branch protection is not configured and cannot be` (#282).

CLAUDE.md states the governing rule — _changed a documented fact ⇒ reconcile every copy of it_ —
and **no reviewer enforces it**. `spec-adherence` watches code↔spec drift in one direction;
nothing watches doc↔doc drift. The rule is prose asking a human to remember.

**Checks that go quiet — the most dangerous class.** ffmpeg tests skipping because CI never
installed the binary ([#180](https://github.com/dylanleatham/Marquee/issues/180),
[#217](https://github.com/dylanleatham/Marquee/issues/217)); `VITEST_MAX_FORKS` stripped by turbo's
strict env mode ([#223](https://github.com/dylanleatham/Marquee/issues/223)); `node --test`
discovering zero test files and exiting 0
([#283](https://github.com/dylanleatham/Marquee/issues/283)). dev-harness §11 elevated this to a
standing rule — _a check that cannot demonstrate it measured something is a failure, not a pass_ —
and enforces it with three bespoke tests guarding the three specific holes that already opened.
Nothing asks the question of a **new** check.

Two further classes are named here so the plan can explicitly decline them:

- **UI geometry** (#300 a preview covering Settings, #226 a header one paint late, #249 log-strip
  docking, #291 three motions offered instead of eight). A reviewer reading a diff cannot see
  geometry any more than jsdom can. The fix is a real-browser smoke gate, not a specialist — out of
  scope here, tracked separately. The one exception is #302 (_every class a component names now
  exists in the stylesheet_), which is a purely static check and should have become a test.
- **Test hermeticity** (#248 env-var isolation, #245 a test that pinned a literal date and expired
  overnight, plus the recurring local `.env` leak). `test-auditor` checks that tests _exist_; nothing
  checks they are _hermetic_. That is a prompt extension to an existing reviewer, not a seventh
  session per run.

---

## 2. Prior art

Four patterns worth taking, and what each is for.

**Self-Harness** ([arXiv 2606.09498](https://arxiv.org/html/2606.09498v1)) — an agent improving its
own harness through a three-stage loop: _weakness mining_ (find failure patterns in execution
traces), _bounded harness proposal_ (minimal edits tied to a specific observed failure), and
_proposal validation_ (accept an edit only after regression testing on held-in/held-out splits;
reject anything that fixes the target case and breaks a passing one). The validation stage is the
whole safety story. The characteristic failure of a self-improving harness is not a bad idea, it is
prompt drift: an edit that fixes the case in front of it and quietly costs recall on five cases
nobody re-ran. §4.2 is that stage; §4.6 is the loop around it.

**Typed dismissals** ([CodeAnt](https://www.codeant.ai/blogs/ai-code-review-false-positives),
[Sonar](https://www.sonarsource.com/blog/how-sonarqube-minimizes-false-positives/)). Published
false-positive rates for AI review sit at 5–15%; the tools that reached ~3% did it by capturing
every dismissal _with a reason_, and specifically by separating **"incorrect"** from **"correct but
won't fix."** Those two drive completely different repairs — a prompt change versus nothing at all —
and collapsing them is what makes most calibration data useless. §4.1 records the distinction.

**Refute-or-promote** ([arXiv 2604.19049](https://arxiv.org/pdf/2604.19049)). Before a finding is
promoted to blocking, a separate pass attempts to _refute_ it — adversarial rather than
confirmatory. Well matched to four blocking reviewers whose false positives are the thing that
teaches a developer to reach for `--no-verify`. §4.5.

**Independent raters** (Google's eval-optimize loop for coding agents, via
[Arize's summary](https://arize.com/blog/closing-the-loop-coding-agents-telemetry-and-the-path-to-self-improving-software/)).
Whatever grades the harness must not be the thing being optimised, or it games its own metric. In
practice here: the eval set's expected verdicts are written by a human from a _known_ escaped bug,
never generated by the specialist being scored, and the retro loop (§4.6) proposes but never accepts.

---

## 3. Design principles

1. **Measure before adding.** No new reviewer lands before the instrument that could retire it
   exists. Otherwise §12's delete rule is unexecutable for the new reviewer too, and the roster
   only ever grows.
2. **A harness edit is a change under test.** Prompts, examples and configs are behaviour. They get
   a regression gate like any other behaviour.
3. **The loop proposes; a human accepts.** The retro reads evidence and writes a proposal file. It
   does not edit a prompt. An agent that can silently rewrite the standards it is judged against has
   no standards.
4. **This document's own rule applies to itself.** Every check introduced here must answer: _what
   does its output look like when it is silently doing nothing, and is that distinguishable from
   success?_ (dev-harness §11.) A precision report computed from four data points must say so rather
   than printing a confident 100%.

---

## 4. The design

### 4.1 The ledger — what the harness remembers

**`review-agents/ledger.jsonl`, committed to the repo.** Reports stay gitignored run artifacts; the
ledger is source. Append-only JSONL, one record per line.

Written by a new verb, `pnpm run review --triage`: it walks the findings of the most recent report
and asks for a verdict on each, thirty seconds after the review while the judgement is still cheap.
Findings are recorded **only** when triaged, so an untriaged run leaves no trace and the file stays
small and deliberate.

Two record kinds:

```jsonc
// One per triaged run — the denominator, and the reviewer-fired rate.
{ "kind": "run", "ts": "2026-08-13T18:22:04Z", "runId": "2026-08-13T18:21:30Z", "sha": "7fa6072…",
  "base": "…",
  "specialists": [ { "id": "runtime", "status": "ran", "durationMs": 79210, "findings": 2 } ] }

// One per triaged finding.
{ "kind": "finding", "ts": "…", "runId": "…", "sha": "7fa6072…", "specialist": "runtime",
  "severity": "blocking", "file": "packages/curator/src/roomArm.ts", "line": 88,
  "message": "The ffmpeg spawn has no timeout, so a hung encode wedges the event loop.",
  "fingerprint": "a8762c3e8e4c", "verdict": "accepted", "note": "" }
```

`message` is stored alongside the fingerprint rather than being reduced to it. A repeat-class table
whose rows read `a8762c3e8e4c ×3` is unreadable, and the ledger is the harness's memory — a memory
that cannot say _what_ was repeated only proves that something was.

`runId` identifies a **review**, not a commit — the report's `createdAt`, falling back to
`sha|base`. One commit can be reviewed more than once (`--staged` now, `--base HEAD~3` after), and
both write the same `report-<sha>.json`, so the second overwrites the first. Keying the run record
on `sha` therefore dropped one of them; see RA-6 in
[KNOWN-ISSUES.md](../../review-agents/KNOWN-ISSUES.md) for what that looked like in the output.

`verdict` is one of:

| verdict    | meaning                                        | counts toward         |
| ---------- | ---------------------------------------------- | --------------------- |
| `accepted` | real, and I changed the code                   | precision numerator   |
| `wrong`    | not a real problem — the reviewer was mistaken | precision denominator |
| `wont-fix` | real, but deliberately not acting on it        | **neither**           |

The `wrong` / `wont-fix` split is the whole point (§2). A reviewer with ten `wont-fix` findings is
calibrated and unlucky in what it notices; a reviewer with ten `wrong` findings needs its prompt
changed or needs retiring. One number cannot tell those apart.

**`fingerprint`** = `sha1(specialist + "|" + normalize(message))`, where `normalize` lowercases and
strips digits, paths and quoted identifiers. It deliberately excludes `file`, so the _same class_ of
finding in a different file matches — which is what makes CLAUDE.md's "no _repeat_ class" bar
measurable instead of remembered.

**`pnpm run review:stats`** reads the ledger and prints, per specialist: volume, fire rate,
precision (`accepted / (accepted + wrong)`), median duration, and the repeat-class table sorted by
count. Per principle 4, it prints an explicit `insufficient data (n=4)` for any specialist under a
threshold rather than a percentage — a precision figure from four findings is a number, not a
measurement, and must not read like one.

**Merge conflicts.** An append-only file edited on parallel branches conflicts on its last line
every time. `.gitattributes` gets `review-agents/ledger.jsonl merge=union`, which is the correct
semantics for an append-only log: both sides' lines survive.

### 4.2 The eval set — what makes a harness edit safe

**`review-agents/eval/cases/<id>/`**, each case a frozen diff plus an expected verdict:

```
cases/223-turbo-strict-env-stripped-fork-cap/
├── case.json      # kind, target specialist, what must be found (or must not be)
└── diff.patch     # the diff as it looked before the fix landed
```

```jsonc
{
  "id": "223-turbo-strict-env-stripped-fork-cap",
  "source": "commit:048ddf1",
  "kind": "must-find",
  "specialist": "null-result",
  "expect": {
    "file": ".github/workflows/ci.yml",
    "matches": ["strict env|VITEST_MAX_FORKS|declared in turbo.json"],
  },
  "notes": "Escaped as issue #223: the fork cap silently never applied and CI stayed green.",
}
```

`kind` is `must-find` or `must-not-find`. Scoring per specialist: **recall** = must-find cases hit /
must-find cases total; **false positives** = must-not-find cases that produced any finding /
must-not-find total.

**The cases seed themselves from history, for free.** Every `fix(...)` commit on `main` is a
must-find case: take the diff of its parent restricted to the files the fix touched, and the
reviewer that should have caught it. Every clean merged feature PR is a must-not-find case. There
are roughly twenty of the former in `git log` today. `review-agents/eval/seed-from-history.mjs`
takes a commit SHA and writes the case skeleton; a human writes the `expect` block, because per §2
the expectation must not come from the thing being scored.

**Non-determinism is handled, not ignored.** A model's output varies run to run, so a single
execution is not a measurement. The runner takes `--repeat N` (default 3) and scores by majority,
recording the spread. A gate that flakes is a gate that gets disabled.

_Measured 2026-08-13, and it is bigger than expected._ Three executions of one identical case
(`runtime-rename-over-served-file`) produced: nothing, a textbook blocking finding naming the bug and
both call sites, nothing. **`runtime` finds a known-real bug about one run in three.** That variance
exceeds anything a prompt edit is likely to cause, which means the default of three repeats is too
few for a baseline — at `p ≈ 1/3`, majority-of-three scores `hit` only about a quarter of the time,
so the case-level outcome is nearly as noisy as the run-level one. Record baselines at `--repeat 5`
or higher, and treat a single case flipping as noise. This is a fact about the roster, not about the
eval; it is simply the first time the harness has been able to state it.

**The gate.** `review-agents/eval/baseline.json` is committed, and it compares at **two
resolutions**. Case level — the majority verdict — is strict and may not go backwards. Run level —
the detection rate, hits over total runs — is the sensitive half, compared against a tolerance of
two standard errors of the baseline rate.

_Both, because the first baseline showed the case-level number alone is the wrong instrument
(added 2026-08-13, after §4.1's ledger and this section had already shipped)._ It is **insensitive
where it matters**: a reviewer sliding from 2/5 to 0/5 on every case has stopped working entirely,
and `hit/total` does not move, since 2/5 and 0/5 are both "miss". It is also **misleading**:
`test-auditor` reads `0/1` recall, which sounds blind, while its runs say 2/5. The tolerance on the
run-level half is wide (≈±22% at the measured rates) and shrinks as `sqrt(runs)`, so the lever for a
tighter gate is more cases and more repeats, not a smaller threshold.

A harness edit may not decrease any specialist's recall or increase its false-positive count
relative to the baseline. When an edit
improves things, the new baseline is committed in the same PR — which makes the improvement a
reviewable diff rather than an assertion in a commit message.

**Cost and placement.** These are real Claude sessions, so the eval runs **locally, on demand** —
never in CI. _(Corrected 2026-08-13, during Phase 2. This section originally put an eval job in
`nightly.yml`. That could not have worked: `nightly.yml` runs on `windows-latest`, a GitHub runner
with no `claude` binary and no auth — which is exactly the property dev-harness §6 chose local
execution to get, "no self-hosted runner to maintain, no runner-inherited auth to manage". An eval
job there would have been a check that can never measure anything, which §11 forbids more strongly
than it forbids skipping the check. CI covers `lib/eval.test.mjs` and nothing more.)_

The consequence is that **the gate is a human discipline, not an enforced one** — nothing stops a
`review-agents/` change landing unevaluated. That is a genuine weakness, accepted because the
alternative is a self-hosted runner holding a Claude credential. See
[ADR 0085](../adrs/0085-a-harness-edit-is-validated-against-a-frozen-case-set.md).

Results are cached on `sha256(case + diff + that specialist's prompt, examples, config, model)`, so
a specialist nobody touched does not re-run its cases. A **mock** run neither reads nor writes that
cache — mock-ness lives in the environment, not in the cache key, so a `REVIEW_MOCK=1` pipeline
check would otherwise seed it with canned empty findings that the next real run reads back as a
measurement. That happened, once, on the first day.

Target for v1: **12 must-find, 8 must-not-find**, drawn from the classes in §1.1. _Shipped with 8
(five must-find, three must-not-find); `security`, `spec-adherence` and `contract-guardian` have no
cases at all and read `0/0`._

### 4.3 Two new specialists, chosen by the escape history

Both are scoped to a single question, per dev-harness §6's "specialists, not generalists."

**`doc-coherence`** _(info)_ — the fact-drift class. Triggers on `docs/**/*.md`, `*.md`,
`packages/**/README.md`. One question: _which other copies of the fact this change edited are now
wrong?_ This is CLAUDE.md's reconcile rule with an enforcer.

Its context cannot be preloaded the way every existing specialist's is: the relevant context is
"whichever of 83 ADRs and 17 specs mention the keywords in this diff," which is a search, not a
glob. Two ways to resolve that, and the choice is a real decision (§6, Phase 3):

- (a) a new routing capability, `contextRelated: { by: "keywords", over: ["docs/**/*.md"],
maxFiles: 8, maxBytes: 120000 }`, which the orchestrator resolves before composing the prompt —
  bounded, cacheable, and reusable by future reviewers; or
- (b) let this specialist use its own tools to grep, since each one is a real headless Claude Code
  session in the repo. Cheaper to build, but it makes `doc-coherence` the first **tool-using**
  specialist — every existing one reviews a preloaded diff and nothing else — with an unbounded and
  unpinnable amount of work behind a fixed budget.

(a) is the recommendation. It keeps every specialist the same shape and keeps the context
inspectable via `--explain`, which is how false positives get diagnosed today. Whether headless
sessions even have tools enabled under the current invocation needs to be **verified, not
assumed**, before (b) is costed.

_Resolved 2026-08-13: (a), built as `lib/related.mjs` and recorded in
[ADR 0086](../adrs/0086-a-specialist-may-be-given-context-found-by-search.md). Choosing it removed
the need to answer the tools question at all. Two properties turned out to be load-bearing: bounded
on four axes (candidates scanned, bytes per file, files returned, total bytes), and **deterministic**
— the eval caches on a specialist's config, so context that reshuffled between runs would make a
cached result meaningless and a re-ordering could read as a regression._

**`null-result`** _(blocking)_ — the silent-green class. Triggers on `.github/workflows/**`,
`turbo.json`, every `package.json`, `scripts/**/*.mjs`, test-runner config, and test files under
`packages/**` — but deliberately **not** ordinary product source, which a test asserts. Context:
`docs/specs/dev-harness.md`. One question, taken verbatim from §11: _what does this check's output
look like when it is silently doing nothing, and is that distinguishable from success?_ Blocking,
because all four instances of this class shipped behind a green tick. Small trigger surface, so it
fires rarely — which is the signal-over-volume property §6 asks for.

**`test-auditor` gains a hermeticity rule** rather than a new reviewer existing for it: a new or
modified test that reads `Date.now()`/`new Date()` without pinning, reads `process.env` the suite
does not clear, touches the network, or writes outside a temp dir, is a finding. Covers #245 and
#248 and the recurring `.env` leak at the cost of a prompt paragraph.

### 4.4 Latency — the inner loop currently cannot be an inner loop

CLAUDE.md instructs running `pnpm run review` "in the inner loop — before the first commit,
iterating to green." The per-specialist budgets sum to roughly twenty minutes worst case, and
nobody iterates against that. Two changes:

**Make the concurrency real.** `orchestrator.mjs:174` maps the specialists through `Promise.all`,
but `runSpecialist` (`lib/claude.mjs`) calls **`spawnSync`** — a blocking call. The code reads as
concurrent and executes strictly one at a time. Switching to `spawn` with a `REVIEW_CONCURRENCY`
cap (default 3) preserves the actual stated rationale — "gentler on a loaded machine than N
concurrent sessions," written when N was 6 — while cutting wall clock. The retry-on-timeout path
(RA-2), mock mode, `shell: IS_WIN` and `maxBuffer` all have to survive the rewrite, and the injected-
`spawn` unit tests move to the async shape.

No speedup is claimed here in advance. It gets measured, and the eval set is what proves recall did
not change — which is why this phase comes after §4.2 and not before.

**A fast tier.** `pnpm run review --fast` runs only the specialists that are both triggered _and_
blocking (`contract-guardian`, `test-auditor`, `runtime`, `security`) — the mid-session check. The
full roster still runs before opening the PR. Also eval-gated: the tier is only worth having if
what it drops is genuinely low-yield.

### 4.5 Refute-or-promote on blocking findings

Before a `blocking` finding gates, one cheap session receives the finding plus the surrounding file
and is asked to **refute** it, defaulting to "stands" unless it can name the specific reason the
finding does not hold. A refuted finding is **demoted to info with the refutation attached** — never
dropped. Dropping would hide it; demoting keeps it readable and un-gating.

This spends tokens only on runs that would otherwise have blocked, which are rare, and it directly
protects the property that makes a gate survive: a blocking false positive is what teaches someone
to reach for `--no-verify`.

It can only ever _cost_ recall, so it ships strictly behind §4.2's gate, and the report records the
refute rate so the trade is observed rather than assumed.

### 4.6 The retro — the loop itself

`pnpm run harness:retro` reads the ledger since the last retro plus every `fix(...)` commit in the
same window, and writes **a proposal file** to `review-agents/retro/<date>.md`: repeat classes that
warrant a prompt rule, specialists whose precision has drifted, escaped bugs with no eval case, and
reviewers whose fire rate has gone to zero.

It does not edit a prompt, a config, or an example. A human reads the proposal, makes the change,
and the change passes `review:eval` against the committed baseline or it does not land. That is
Self-Harness's propose → validate → accept, with a human holding accept — principle 3.

---

## 5. What this deliberately isn't

- **Not an agent that rewrites its own prompts.** See principle 3. The proposal/accept split is the
  design, not a phase-one limitation to be removed later.
- **Not a dashboard.** The ledger is JSONL and `review:stats` prints a table. dev-harness §11 is
  right that these should be files spot-checked periodically.
- **Not per-PR eval.** Real Claude sessions against twenty cases do not belong in a four-job
  pipeline priced per PR.
- **Not a replacement for `KNOWN-ISSUES.md`.** That tracks harness _defects_; the ledger tracks
  finding _quality_. Both stay.
- **Not a fix for the UI-geometry class.** §1.1 explains why an agent is the wrong instrument there.
- **Not fully automated triage.** A verdict is a judgement about the codebase. Asking a model to
  grade the model is the independent-rater failure in §2.

---

## 6. Implementation plan

Six phases, each one PR, each independently useful if the next never happens. Ordering is forced by
principle 1: the instrument precedes what it measures, and the gate precedes what it gates.

Every phase carries the repo's standing obligations — the spec updates named below land in the
**same** PR (CLAUDE.md, "Specs are the source of truth"), and ADR numbers are taken from
`pnpm run check:adrs` **at push time**, never allocated in advance from this document. As of writing
the next free number is 0085, and it will not still be 0085 by the time Phase 1 is pushed.

### Phase 1 — the ledger (no Claude calls, no new cost) — **shipped 2026-08-13**

**Goal:** §12's delete rule becomes executable.

Built as planned, with three decisions the plan left open:

- **Triage is interactive, and appends after every verdict** (open question 2, now closed). A pass
  that batched to the end would lose everything if you quit halfway through a twelve-finding run,
  which is the amnesia this phase exists to fix. Re-running `--triage` resumes on exactly the
  findings not already in the ledger. It refuses to run when stdin is not a TTY rather than hanging
  — an interactive verb that wedges a hook would be a worse harness bug than an unmeasured reviewer.
- **A note is asked for only on `wrong`.** That is the verdict whose reason is actionable; asking on
  every finding slows the common case, and a triage nobody runs measures nothing.
- **`resolveReport` falls back to the newest report** when none matches `HEAD`. You review, you fix
  what it found, you commit — and the report is now for a commit that no longer exists. Refusing
  there would mean the ledger only ever remembers findings you _didn't_ act on, which inverts the
  measurement.

|                                |                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New**                        | `review-agents/lib/ledger.mjs` — `fingerprint()`, `appendRecords()`, `readLedger()`, `computeStats()`                                                                                                                                                                                                                    |
|                                | `review-agents/ledger.jsonl` (seeded empty)                                                                                                                                                                                                                                                                              |
|                                | `.gitattributes` — `review-agents/ledger.jsonl merge=union`                                                                                                                                                                                                                                                              |
| **Changed**                    | `orchestrator.mjs` — `--triage` and `--stats` verbs                                                                                                                                                                                                                                                                      |
|                                | root `package.json` — `review:stats` script                                                                                                                                                                                                                                                                              |
|                                | `.gitignore` — comment at line 61 clarifying that reports are artifacts and the ledger is not                                                                                                                                                                                                                            |
| **Tests** (`lib/lib.test.mjs`) | `fingerprint` is stable across digits/paths/quoted identifiers and distinguishes different classes; `computeStats` excludes `wont-fix` from both sides of precision; `computeStats` reports insufficient data below threshold instead of a percentage; `readLedger` tolerates a partial trailing line (crash mid-append) |
| **Docs**                       | dev-harness §11 (replace the "later" note on the findings dashboard) and §12 (name the instrument); `review-agents/README.md` (the two new verbs)                                                                                                                                                                        |
| **Done when**                  | a real review is triaged end to end and `review:stats` prints a table with an honest `insufficient data` for every specialist                                                                                                                                                                                            |

No ADR — this adds an instrument, it does not deviate from a spec.

### Phase 2 — the eval harness and its baseline — **shipped 2026-08-13**

**Goal:** a harness edit can be shown not to have regressed.

Built, with four departures from the plan above:

- **It runs locally, not in `nightly.yml`.** The plan's CI job was impossible; see §4.2. This is the
  single biggest change, because it turns an enforced gate into a discipline.
- **`buildContext` and `loadSpecialists` moved to `lib/specialists.mjs`.** The eval is only a
  measurement of the _real_ reviewer if it hands that reviewer byte-for-byte the context a real
  review would. A second copy in the eval would drift, and the eval would then keep reporting green
  about a reviewer that no longer exists.
- **Four outcomes, not two.** `not-triggered` and `not-installed` are reported separately from
  `miss`, so a routing bug is never mistaken for a prompt problem (issue #192) and a case can be
  committed ahead of its reviewer — which is what Phase 3 needs.
- **No baseline is committed yet.** Recording one costs `cases × repeats` real sessions, and a
  baseline written from a run nobody inspected would be a number pretending to be a measurement.
  `run.mjs` exits non-zero until `--write-baseline` is used deliberately.

|               |                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New**       | `review-agents/eval/run.mjs` — case loader, `--repeat` majority scoring, content-hash cache, baseline comparison                                                                                                                                                                                                                            |
|               | `review-agents/eval/seed-from-history.mjs` — commit SHA → case skeleton                                                                                                                                                                                                                                                                     |
|               | `review-agents/eval/cases/**` — 12 must-find, 8 must-not-find                                                                                                                                                                                                                                                                               |
|               | `review-agents/eval/baseline.json`                                                                                                                                                                                                                                                                                                          |
| **Changed**   | `.github/workflows/nightly.yml` — an `eval` job (nightly only; see dev-harness §5)                                                                                                                                                                                                                                                          |
|               | root `package.json` — `review:eval`                                                                                                                                                                                                                                                                                                         |
| **Tests**     | case-file schema validation; cache key changes when a specialist's prompt/examples/config/model changes and **not** when an unrelated file does; majority scoring across repeats; baseline comparison fails on a recall drop and on an FP increase; **a run that scored zero cases exits non-zero** (§11 applied to the eval runner itself) |
| **Docs**      | dev-harness §11 (the `review-agents/eval/` line stops being aspirational); `review-agents/eval/README.md` (how to add a case)                                                                                                                                                                                                               |
| **Done when** | `pnpm run review:eval` produces a per-specialist recall/FP table, and deliberately breaking one specialist's prompt makes it fail                                                                                                                                                                                                           |

**ADR:** _a harness edit is validated against a frozen case set before it lands._ This is a new
obligation on every future PR that touches `review-agents/`, which is exactly what an ADR is for.

Seeding order — start with the cases that are already understood: #223, #283, #180/#217
(`null-result`); #316, #260, #236 (`doc-coherence`); #248, #245 (`test-auditor` hermeticity);
#173, #307 (`runtime`). Must-not-find cases come from recent clean feature merges (#292, #293, #295).

### Phase 3 — the two new specialists, cases first — **shipped 2026-08-13**

Both reviewers exist and both detect. Two results worth carrying forward:

- **`doc-coherence` works and is worth the slot.** It hit its ADR-citation case on the first attempt
  and found a contradiction the case did not ask for — `oauth.ts` citing ADR 0017 and 0016 for the
  same decision one sentence apart.
- **`null-result` detects a check that no-ops, not one that is deleted.** 1/3 on a hand-authored
  newly-added silent-skip step; **0 across nine runs** when a guard is removed wholesale, which it
  reads as a deliberate revert. Its own prompt asks for the second case, so that gap is real, and it
  sits in the baseline at zero rather than being deleted — the cases are the evidence of the gap.

Both findings came from the eval, and neither was visible without it. Two of the five seeded cases
turned out to be invalid, which is the other lesson: a reversed fix is a plausible-looking commit,
and plausible-looking is not the same as in-scope for the reviewer being scored.

**Goal:** cover the two largest escaped classes.

Test-first, exactly as [bug-fix-workflow.md](bug-fix-workflow.md) requires: **write the eval cases
first and watch the roster fail them**, then add the specialist. A reviewer whose cases never went
red proves nothing, same as a test.

|               |                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New**       | `review-agents/doc-coherence/{config.json,system-prompt.md,examples.md}`                                                                                                                                                                                                                                                                                     |
|               | `review-agents/null-result/{config.json,system-prompt.md,examples.md}`                                                                                                                                                                                                                                                                                       |
|               | `contextRelated` resolution in `orchestrator.mjs` + `lib/util.mjs` (option (a), §4.3)                                                                                                                                                                                                                                                                        |
| **Tests**     | `contextRelated` is bounded by `maxFiles`/`maxBytes` and deterministic in ordering; both new dirs satisfy the existing "every specialist directory has the three files" and trigger-declaration tests; `null-result`'s globs match every workflow and test-script path on disk (the `packages/**/src/**` lesson from RA-5, applied to a new trigger surface) |
| **Docs**      | dev-harness §6 roster table; `review-agents/README.md` roster table and the `config.json` field list                                                                                                                                                                                                                                                         |
| **Done when** | the Phase-2 cases for both classes go from red to green, and neither specialist fires on the must-not-find set                                                                                                                                                                                                                                               |

**ADR:** _a specialist may be given context resolved by search rather than by glob_ — with the §4.3
(a)/(b) decision and the rejection of (b) recorded, including the unverified question of whether
headless sessions have tools at all.

`doc-coherence` starts **info**. Promote to blocking only once the ledger shows its precision holds
— which is Phase 1 paying for itself.

### Phase 4 — latency, proven not to cost recall

**Goal:** the inner loop becomes affordable enough to actually be used as one.

|               |                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Changed**   | `lib/claude.mjs` — `spawnSync` → `spawn`, promise-returning `runSpecialist`, retry path preserved                                                                                                                         |
|               | `orchestrator.mjs` — `REVIEW_CONCURRENCY` (default 3) pool; `--fast` tier                                                                                                                                                 |
| **Tests**     | the injected-spawn retry tests, ported to async, still assert retry-on-timeout-only; the pool never exceeds its cap; `--fast` selects exactly triggered ∧ blocking; a timeout in one specialist does not abort the others |
| **Docs**      | `review-agents/README.md` (the "one at a time — gentler on a loaded machine" paragraph is now wrong); dev-harness §6 orchestration                                                                                        |
| **Done when** | wall clock on a full run is measured before and after and recorded in the PR, **and** `review:eval` matches baseline                                                                                                      |

**ADR:** _specialists run concurrently under a cap_ — the sequential choice was deliberate and
documented, so reversing it is a recorded decision, with the measured numbers in the consequences.

### Phase 5 — hermeticity and refute-or-promote

**Goal:** raise blocking-finding precision; close the test-hermeticity class.

|               |                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Changed**   | `test-auditor/system-prompt.md` + `examples.md` — the hermeticity rule and its false positives                                                                                                                                                                                  |
|               | `orchestrator.mjs` + new `lib/refute.mjs` — refute pass on blocking findings only, demote-with-reason, `refuted` count in the report                                                                                                                                            |
| **Tests**     | a refuted finding is demoted and never dropped, and carries its refutation; a failed/timed-out refute leaves the finding **blocking** (fail closed — an unavailable refuter must not silently un-gate a push); the pass is skipped entirely when there are no blocking findings |
| **Docs**      | dev-harness §6 (blocking semantics now have two stages); `review-agents/README.md`                                                                                                                                                                                              |
| **Done when** | `review:eval` shows no recall loss on must-find cases and a measurable FP drop, or the refute pass does not ship                                                                                                                                                                |

**ADR:** _a blocking finding must survive a refutation to gate a push._

That fail-closed rule is the §11 discipline applied to the new component: a refuter that isn't
running must not be indistinguishable from a refuter that agreed.

### Phase 6 — the retro, and making the workflow executable

**Goal:** close the loop, and move the workflow rules from prose into mechanism.

|               |                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New**       | `review-agents/retro.mjs` + `review-agents/retro/` (proposal output)                                                                                                                                     |
|               | `.claude/skills/fix-bug/` — the bug-fix workflow, with the _watch it fail_ step made explicit                                                                                                            |
|               | `.claude/skills/new-adr/` — allocation via `pnpm run check:adrs`, never `ls docs/adrs/`                                                                                                                  |
|               | `.claude/settings.json` — a **Stop hook** that notices the session touched `packages/**/src/**` with no review report for the working tree, and says so                                                  |
| **Tests**     | the retro reads a fixture ledger and emits proposals without mutating any prompt/config file (assert the tree is unchanged); the ADR skill's allocation path fails when `check:adrs` reports a collision |
| **Docs**      | dev-harness §12 (the loop it describes now has a mechanism); CLAUDE.md (point the prose rules at the skills that execute them)                                                                           |
| **Done when** | one retro runs against real ledger data and produces at least one proposal that survives the eval gate                                                                                                   |

The Stop hook is a **nudge, never a gate**. A blocking hook on every session is how people learn to
work around the harness, and there is a `--no-verify` shaped hole waiting for exactly that.

There is a live constraint here: this repo currently has **no committed `.claude/` at all** — no
subagents, no skills, no slash commands, no hooks. Every workflow rule is CLAUDE.md prose that a
session must read and choose to obey. That gap has a measured cost: four ADR collisions have shipped
despite `pnpm run check:adrs` existing and being correct. The distance between a documented rule and
an executed one is exactly what this phase closes.

### Sequencing summary

| Phase                  | Depends on                         | Adds ongoing cost               | ADR |
| ---------------------- | ---------------------------------- | ------------------------------- | --- |
| 1 Ledger               | —                                  | none                            | no  |
| 2 Eval                 | 1 (for the questions worth asking) | nightly job                     | yes |
| 3 Specialists          | 2 (cases first)                    | +2 sessions per triggering run  | yes |
| 4 Latency              | 2 (to prove no recall loss)        | none (reduces)                  | yes |
| 5 Refute + hermeticity | 2, 4                               | ~1 session per blocking finding | yes |
| 6 Retro + `.claude/`   | 1, 2                               | none                            | no  |

Phases 1 and 2 are the load-bearing pair and should land before anything else is considered. Phases
3–5 are independently droppable. Phase 6 is valuable on its own and could be pulled forward if the
`.claude/` gap starts costing more than the review gaps do.

---

## 7. Risks

**The ledger goes stale because triage is skipped.** The mitigation is that triage is optional and
cheap and produces something visible (`review:stats`), not that it is enforced. If it is still empty
after a month, that is the answer to whether this was worth building — and `review:stats` will say
`insufficient data`, which is the honest output, not a silent zero.

**The eval set overfits.** Twenty cases drawn from history is a small, biased sample: it is exactly
the set of bugs that already escaped. It guards against _regression_, not against _unknown classes_,
and must not be read as a quality score. Held-out cases (added but not baselined until the next
cycle) partially address this; the honest framing is that it is a regression gate, full stop.

**Two more specialists is two more sessions per run.** Both have narrow triggers and Phase 4 pays for
them in wall clock. If either one's precision does not hold in the ledger, §12's delete rule now has
an instrument and should be used — including on reviewers proposed in this document.

**The retro proposes noise.** It is a file a human reads. The failure mode is a wasted five minutes,
which is the correct amount of authority for an unproven loop to have.

---

## 8. Open questions

1. **Do headless specialist sessions have tools?** `claude -p --output-format json` with a piped
   prompt — unverified. It determines whether §4.3(b) was ever a real option and whether the current
   specialists could be reading files nobody accounted for in their budgets.
2. ~~**Triage UX.**~~ _Closed 2026-08-13 by Phase 1: interactive, appending after every verdict, and
   resumable. The append-as-you-go behaviour buys the interruption-friendliness that the markdown
   round-trip was wanted for, without a second mechanism to maintain._
3. **Ledger retention.** Append-only forever, or roll to `ledger-<year>.jsonl`? Not urgent at the
   current rate; worth deciding before the file is large enough that the decision costs a migration.
4. **Should `--fast` be what the Stop hook nudges toward?** It is the tier that fits an inner loop,
   but nudging toward the partial run may quietly become nudging away from the full one.
