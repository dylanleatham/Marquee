# Review agents

Specialist Claude Code reviewers that read a diff and surface things worth thinking about. You
run them **on demand** with `pnpm run review` — typically right before opening a PR. They are
deliberately NOT in the pre-push hook (6 real Claude sessions add 1–2 min to every push, and on
the free plan nothing enforces a report anyway). Design: `docs/specs/dev-harness.md §6`.

## The roster

| Specialist            | Blocking? | Watches                             | Catches                                                     |
| --------------------- | --------- | ----------------------------------- | ----------------------------------------------------------- |
| **contract-guardian** | ✅        | `packages/contracts/**` + importers | breaking schema changes, unupdated consumers                |
| **test-auditor**      | ✅        | production `src/**`                 | new endpoints/functions/transitions without tests           |
| **spec-adherence**    | info      | `src/**`                            | code ↔ spec drift (either direction)                        |
| **consistency**       | info      | code files                          | naming / error / log / structure drift                      |
| **runtime**           | ✅        | code files                          | missing timeouts, throws in async chains, leaks, races      |
| **security**          | ✅        | all changes                         | hardcoded secrets, injection, path traversal, disabled auth |

Only findings a **blocking** specialist explicitly marks `"blocking"` fail the push. Everything
else is informational.

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
```

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
auto-load the spec(s) for changed packages).

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
