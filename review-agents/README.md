# Review agents

Specialist Claude Code reviewers that read a diff and surface things worth thinking about. You
run them **on demand** with `pnpm run review` — typically right before opening a PR. They are
deliberately NOT in the pre-push hook (8 real Claude sessions add minutes to every push, and on
the free plan nothing enforces a report anyway). Design: `docs/specs/dev-harness.md §6`.

> **Editing a specialist's prompt, examples or config is a change under test.** Run
> `pnpm run review:eval` before you merge it — it scores every reviewer against
> [frozen cases](eval/README.md) and fails if recall drops or false positives rise
> ([ADR 0085](../docs/adrs/0085-a-harness-edit-is-validated-against-a-frozen-case-set.md)). Nothing
> enforces this: the eval needs a real `claude` session, so it cannot run on a CI runner. It is a
> discipline, and the [ledger](#the-ledger--what-this-harness-remembers) is what tells you whether
> the discipline is working.

## The roster

| Specialist            | Blocking? | Watches                             | Catches                                                     |
| --------------------- | --------- | ----------------------------------- | ----------------------------------------------------------- |
| **contract-guardian** | ✅        | `packages/contracts/**` + importers | breaking schema changes, unupdated consumers                |
| **test-auditor**      | ✅        | production `src/**`                 | new endpoints/functions/transitions without tests           |
| **spec-adherence**    | info      | `src/**`                            | code ↔ spec drift (either direction)                        |
| **consistency**       | info      | code files                          | naming / error / log / structure drift                      |
| **runtime**           | ✅        | code files                          | missing timeouts, throws in async chains, leaks, races      |
| **security**          | ✅        | all changes                         | hardcoded secrets, injection, path traversal, disabled auth |
| **null-result**       | ✅        | workflows, manifests, task config   | a new check that no-ops into a green tick (see ⚠ below)     |
| **doc-coherence**     | info      | docs, and any file citing an ADR    | the copy of a fact nobody updated                           |

Only findings a **blocking** specialist explicitly marks `"blocking"` fail the push. Everything
else is informational.

> ⚠ **`null-result` catches a check that no-ops, not one that is deleted.** Measured: it detects a
> newly-added step that silently skips (1/3 runs, in line with the rest of the roster), and detects
> **nothing** when a guard is removed wholesale — 0 across nine runs, which reads to it as a
> deliberate revert. Its own prompt asks for that second case, so the gap is real and is recorded in
> the baseline rather than papered over. Details:
> [eval/README.md](eval/README.md#a-reversed-guard-removal-is-the-wrong-shape-for-null-result).

## How it works

`orchestrator.mjs`:

1. Resolves the diff base (`origin/main` merge-base for a branch; `--staged` or `--base` to override).
2. Computes changed files + a capped unified diff.
3. Routes: each specialist's `config.json` declares what triggers it and what context to load.
4. Runs each relevant specialist via Claude Code headless (`claude -p --output-format json`). The
   call is a blocking `spawnSync`, so specialists run **one at a time** — gentler on a loaded
   machine than N concurrent sessions. A specialist that overruns its budget retries once (RA-2).
5. Parses each reply into findings. A reply that isn't the JSON array gets **one reformat round** —
   the specialist is asked to translate its own reply into the contract shape, with no diff attached,
   so structure (file, line, severity) survives instead of collapsing into one unstructured info
   finding (issue #117). Only if that also comes back as prose does it fall through to surfacing the
   prose itself rather than dropping it (RA-1). Then aggregates and dedupes by file+line+message.
6. Writes `.review-agents/report-<sha>.json` (gitignored) and prints a summary.
7. In `--ci` mode, exits non-zero if there's any blocking finding — **or if a blocking specialist
   produced no verdict at all** (timed out, or returned something unparseable). A dimension that
   went unreviewed is a hole in the review, not a pass; the summary names it, the "No findings"
   message is withheld, and the report records `silentBlocking` (issue #116).

If Claude Code isn't reachable (not installed / not logged in), the run **skips without
blocking** — unavailable ≠ invalid. That's the harness not running at all, which is visible; it is
not the same as a review that silently covered less than it claims.

## Commands

```bash
pnpm run review                     # review this branch vs origin/main
pnpm run review --staged            # review staged changes
pnpm run review --reviewer security # run one specialist
pnpm run review --explain           # also print the context sent to each specialist
pnpm run review --ci                # hook mode: write report, exit 1 on blocking findings
pnpm run review --triage            # judge the last report's findings into the ledger
pnpm run review:stats               # what the ledger adds up to
pnpm run review:eval                # score the reviewers against the frozen case set
```

## The ledger — what this harness remembers

Reports (`.review-agents/report-<sha>.json`) are gitignored run artifacts, so on their own every run
is amnesiac. `--triage` walks the findings of the most recent report and records a verdict for each
into **`review-agents/ledger.jsonl`, which is committed**. Design and rationale:
[harness-self-improvement.md](../docs/specs/harness-self-improvement.md) §4.1.

| verdict        | meaning                                        | counts toward         |
| -------------- | ---------------------------------------------- | --------------------- |
| `[a] accepted` | real, and I changed the code                   | precision numerator   |
| `[w] wrong`    | not a real problem — the reviewer was mistaken | precision denominator |
| `[x] wont-fix` | real, but deliberately not acting on it        | **neither**           |

The `wrong` / `wont-fix` split is the point. A reviewer with ten `wont-fix` findings is calibrated
and unlucky in what it notices; a reviewer with ten `wrong` findings needs its prompt changed or
needs retiring under dev-harness §12. One number cannot tell those apart. Only `wrong` is asked for
a reason, because that is the reason a prompt fix gets argued from.

Triage appends after **every** verdict, so quitting halfway keeps what you judged and re-running it
asks only about the rest. It is interactive and refuses to run when stdin is not a terminal — never
put it in a hook or a CI job.

`review:stats` prints volume, fire rate, precision and the repeat-class table. Below **n=8** judged
findings it prints `insufficient data (n=…)` rather than a percentage: a ratio from two data points
is a number, not a measurement, and dev-harness §11's rule against checks that measure nothing
applies to this instrument as much as to the ones it watches.

Commit the ledger with your PR. `.gitattributes` marks it `merge=union` so two branches that both
triaged a review keep both sides' records.

Env: `CLAUDE_CODE_PATH` (binary override, default `claude`), `REVIEW_MOCK=1` (skip real calls —
used by tests/CI to exercise the pipeline without tokens; `REVIEW_MOCK_OUTPUT` supplies a
canned findings array), `REVIEW_TIMEOUT_MS` (default spawn budget in ms, default
`90000` — bump it on a slow/loaded machine if a specialist gets marked unavailable),
`REVIEW_TIMEOUT_RETRIES` (extra attempts on a timeout, default `1`; set `0` to disable),
`REVIEW_REPAIR_TIMEOUT_MS` (budget for the reformat round, default `60000` — it carries no diff, so
it is much cheaper than a review).

A specialist's own `timeoutMs` in its `config.json` overrides `REVIEW_TIMEOUT_MS`. Prefer that for a
reviewer that is _inherently_ slow rather than raising the global default: `runtime` and
`spec-adherence` get 300s, `consistency` 240s, `test-auditor` 180s, and everything else stays at 90s
so a genuinely stuck fast specialist still fails quickly.

The prompt is assembled in `lib/prompt.mjs` as **system prompt → examples → the diff → the output
contract**, in that order. The contract goes last on purpose: it used to sit before the review
context, which on a large diff left thousands of tokens between "reply with JSON only" and the moment
of replying, and the specialists reliably drifted into prose (issue #117). A test pins the ordering.

## Anatomy of a specialist

```
<specialist>/
├── config.json       # id, blocking, model, timeoutMs, trigger*/context globs
├── system-prompt.md  # the role, blocking rules, what to ignore
└── examples.md       # few-shot good findings + false positives to avoid
```

The orchestrator appends a shared strict output contract (JSON findings array) to every prompt,
so prompts focus on the reviewing role, not the format.

**Add a specialist:** create a directory with those three files. No orchestrator change needed —
it auto-discovers any dir containing a `config.json`.

**config.json fields:** `id`, `blocking` (bool), `model`, `timeoutMs` (spawn budget in ms; overrides
`REVIEW_TIMEOUT_MS`), and any of `triggerAll` (bool),
`triggerGlobs` (string[]), `triggerImports` (string[] — run if a changed file's text contains
one), `contextGlobs` (string[] — files to load into context), `includePackageSpecs` (bool —
auto-load the spec(s) for changed packages), `contextRelated` (object — context found by search).

**`contextRelated`** exists for a reviewer whose context cannot be named in advance
([ADR 0086](../docs/adrs/0086-a-specialist-may-be-given-context-found-by-search.md)). `doc-coherence`
asks "which other copies of this fact are now wrong?", and the answer is whichever of 80-plus ADRs
and 17 specs happen to mention what the diff touched — a search, not a glob. Files are scored by how
many distinct keywords from the change they contain, and appear in the prompt under
`# Possibly related`, deliberately worded so the reviewer treats them as a lead rather than as
authority.

```jsonc
"contextRelated": { "over": ["docs/**/*.md"], "maxFiles": 6, "maxBytes": 100000 }
```

Bounded on four axes (candidates scanned, bytes per file, files returned, total bytes) and
deterministic — the eval caches on a specialist's config, so context that reshuffled between runs
would make a cached result meaningless. See `lib/related.mjs`.

**Write source globs as `packages/**/src/**`, never `packages/*/src/**`.** A single `*` matches one
path segment, and not every package keeps its source one level down — `packages/curator/ui/src/` and
`packages/fakes/*/src/` are both a level deeper. `test-auditor` carried the `*` form and so never ran
on any of Curator's React UI ([issue #192](https://github.com/dylanleatham/Marquee/issues/192)); a
reviewer that is never _triggered_ produces no `[GAP]` warning, so the run reads as a clean pass. A
test in `lib/lib.test.mjs` discovers every `packages/**/src` directory on disk and fails if a
source-scoped reviewer can't see it — if you add a nested package, that test is what tells you.

## Notes

- Pure logic (glob routing, findings parse/dedupe) is unit-tested in `lib/lib.test.mjs` and runs
  in CI like any other package.
- Run before opening a PR: `pnpm run review` (or `--ci` to get a non-zero exit on blocking
  findings). Not wired into pre-push — see the note at the top of this file.
- Cost lives in your existing Claude Code subscription for local/hook runs.
