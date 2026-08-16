# Review agents

Three Claude Code reviewers that read a diff and surface things worth thinking about. Run them on
demand — `pnpm run review`, about a minute — ideally before the first commit, not as a gate before
the PR. They are deliberately NOT in `pre-push`. Design: `docs/specs/dev-harness.md §6`.

Each one encodes something a general-purpose reviewer cannot know about this repo. Generic review —
correctness bugs, security, style — is what `/code-review` and `/security-review` are for, and they
are maintained by someone other than us.

## The roster

| Reviewer           | Blocking? | Watches                           | Catches                                                  |
| ------------------ | --------- | --------------------------------- | -------------------------------------------------------- |
| **null-result**    | ✅        | workflows, manifests, task config | a new check that no-ops into a green tick                |
| **test-auditor**   | ✅        | all first-party source            | new endpoints/functions/transitions without tests        |
| **spec-adherence** | info      | source **and** docs               | code ↔ spec drift, and the copy of a fact nobody updated |

Only findings a **blocking** reviewer explicitly marks `"blocking"` fail a `--ci` run. Everything
else is informational — `[note]` in the output.

## Reading the output

```
[FIX ] test-auditor  packages/curator/src/routes/covers.ts:41
        New POST /api/covers route ships with no test.
        → Add a case to packages/curator/test/routes.test.ts.

[note] spec-adherence  docs/specs/curator-spec.md:212
        This change implements cover upload, but the spec still lists it under 'Deferred'.
```

`[FIX ]` is blocking; `[note]` is for your judgement. That is the whole output — there is no report
to triage, no ledger to commit, and no second command to run afterwards.

## Commands

```bash
pnpm run review                          # this branch vs origin/main
pnpm run review --staged                 # staged changes only
pnpm run review --reviewer null-result   # one reviewer
pnpm run review --explain                # also print the context each reviewer got
pnpm run review --ci                     # exit 1 on blocking findings
```

## How it works

`orchestrator.mjs`:

1. Resolves the diff base (`origin/main` merge-base for a branch; `--staged` or `--base` to override).
2. Computes changed files + a capped unified diff.
3. Routes: each reviewer's `config.json` declares what triggers it and what context to load.
4. Runs each triggered reviewer via Claude Code headless (`claude -p --output-format json`), at most
   `REVIEW_CONCURRENCY` (default **3**) at a time
   ([ADR 0087](../docs/adrs/0087-specialists-run-concurrently-under-a-cap.md)). One that overruns its
   budget retries once (RA-2).
5. Parses each reply into findings. A reply that isn't the JSON array gets **one reformat round** —
   the reviewer is asked to translate its own reply into the contract shape, with no diff attached,
   so structure (file, line, severity) survives (issue #117). Only if that also comes back as prose
   does it fall through to surfacing the prose itself rather than dropping it (RA-1). Then dedupes by
   file+line+message.
6. Writes `.review-agents/report-<sha>-<ts>.json` (gitignored) and prints the summary. The report has
   exactly one reader: the Stop hook, which compares its mtime against the working tree to know
   whether the reviewers have seen the current change.
7. In `--ci` mode, exits non-zero if there's any blocking finding — **or if a blocking reviewer
   produced no verdict at all** (timed out, or returned something unparseable). A dimension that went
   unreviewed is a hole in the review, not a pass; the summary names it, the "No findings" message is
   withheld, and the report records `silentBlocking` (issue #116).

If Claude Code isn't reachable (not installed / not logged in), the run **skips without blocking** —
unavailable ≠ invalid. That's the harness not running at all, which is visible; it is not the same as
a review that silently covered less than it claims.

**One run per reviewer.** Detection is imperfect per run — a reviewer can recognise a bug and fail to
mention it — so a review is a useful signal, not a proof. If a change is worth more confidence, run
it again; two runs leave two reports and cost two minutes.

## Env

`REVIEW_CONCURRENCY` (sessions in flight, default `3` — drop to `1` on a loaded machine),
`CLAUDE_CODE_PATH` (binary override, default `claude`), `REVIEW_MOCK=1` (skip real calls — used by
tests to exercise the pipeline without tokens; `REVIEW_MOCK_OUTPUT` supplies a canned findings
array), `REVIEW_TIMEOUT_MS` (default spawn budget in ms, default `90000`),
`REVIEW_TIMEOUT_RETRIES` (extra attempts on a timeout, default `1`), `REVIEW_REPAIR_TIMEOUT_MS`
(budget for the reformat round, default `60000`).

A reviewer's own `timeoutMs` in its `config.json` overrides `REVIEW_TIMEOUT_MS`. Prefer that for a
reviewer that is _inherently_ slow: `spec-adherence` gets 300s, `test-auditor` and `null-result`
180s, so a genuinely stuck fast reviewer still fails quickly.

The prompt is assembled in `lib/prompt.mjs` as **system prompt → examples → the diff → the output
contract**, in that order. The contract goes last on purpose: it used to sit before the review
context, which on a large diff left thousands of tokens between "reply with JSON only" and the moment
of replying, and the reviewers reliably drifted into prose (issue #117). A test pins the ordering.

## Anatomy of a reviewer

```
<reviewer>/
├── config.json       # id, blocking, model, timeoutMs, trigger*/context globs
├── system-prompt.md  # the role, blocking rules, what to ignore
└── examples.md       # few-shot good findings + false positives to avoid
```

The orchestrator appends a shared strict output contract (JSON findings array) to every prompt, so
prompts focus on the reviewing role, not the format.

**Add one:** create a directory with those three files. No orchestrator change needed — it
auto-discovers any dir containing a `config.json`. Adding a fourth reviewer is a real cost: it is
another minute on every review and another prompt to keep honest. The bar is a class of defect that
has escaped this repo more than once and that no existing reviewer watches.

**config.json fields:** `id`, `blocking` (bool), `model`, `timeoutMs` (spawn budget in ms; overrides
`REVIEW_TIMEOUT_MS`), and any of `triggerAll` (bool), `triggerGlobs` (string[]), `triggerImports`
(string[] — run if a changed file's text contains one), `contextGlobs` (string[] — files to load into
context), `includePackageSpecs` (bool — auto-load the spec(s) for changed packages),
`contextRelated` (object — context found by search).

**Context is selected by section, not by the first 16KB**
([ADR 0090](../docs/adrs/0090-context-is-selected-by-section-not-by-the-first-16kb.md)). A file that
fits the budget arrives whole. A larger one is split into heading blocks, each scored against
keywords from the diff, and the best are kept until the budget runs out — in document order, with
`… N section(s) omitted …` where the gaps are. This replaces taking the front of the file, which for
`curator-spec.md` meant 7% of it and dropped `## 8. HTTP API` — the section a reviewer of `server.ts`
actually needs (issue #325).

**`contextRelated`** exists for a reviewer whose context cannot be named in advance
([ADR 0086](../docs/adrs/0086-a-specialist-may-be-given-context-found-by-search.md)).
`spec-adherence` asks "which other copies of this fact are now wrong?", and the answer is whichever
of 90-odd ADRs and 16 specs happen to mention what the diff touched — a search, not a glob. Files are
scored by how many distinct keywords from the change they contain, and appear in the prompt under
`# Possibly related`, worded so the reviewer treats them as a lead rather than as authority.

```jsonc
"contextRelated": { "over": ["docs/**/*.md"], "maxFiles": 6, "maxBytes": 100000 }
```

Bounded on four axes (candidates scanned, bytes per file, files returned, total bytes) and
deterministic. See `lib/related.mjs`.

**Write source globs as `packages/**/src/**`, never `packages/*/src/**`.** A single `*` matches one
path segment, and not every package keeps its source one level down — `packages/curator/ui/src/` and
`packages/fakes/*/src/` are both a level deeper. `test-auditor` carried the `*` form and so never ran
on any of Curator's React UI ([issue #192](https://github.com/dylanleatham/Marquee/issues/192)); a
reviewer that is never _triggered_ produces no `[GAP]` warning, so the run reads as a clean pass. A
test in `lib/lib.test.mjs` discovers every `packages/**/src` directory on disk and fails if a
source-scoped reviewer can't see it — if you add a nested package, that test is what tells you.

## Notes

- Pure logic (glob routing, findings parse/dedupe, context selection) is unit-tested in `lib/` and
  runs in CI like any other package.
- Cost lives in your existing Claude Code subscription.
