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
4. Runs the relevant specialists **in parallel** via Claude Code headless (`claude -p --output-format json`).
5. Parses each reply into findings, aggregates, dedupes by file+line+message.
6. Writes `.review-agents/report-<sha>.json` (gitignored) and prints a summary.
7. In `--ci` mode, exits non-zero if there's any blocking finding.

If Claude Code isn't reachable (not installed / not logged in), the run **skips without
blocking** — unavailable ≠ invalid.

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
canned findings array).

## Anatomy of a specialist

```
<specialist>/
├── config.json       # id, blocking, model, trigger*/context globs
├── system-prompt.md  # the role, blocking rules, what to ignore
└── examples.md       # few-shot good findings + false positives to avoid
```

The orchestrator appends a shared strict output contract (JSON findings array) to every prompt,
so prompts focus on the reviewing role, not the format.

**Add a specialist:** create a directory with those three files. No orchestrator change needed —
it auto-discovers any dir containing a `config.json`.

**config.json fields:** `id`, `blocking` (bool), `model`, and any of `triggerAll` (bool),
`triggerGlobs` (string[]), `triggerImports` (string[] — run if a changed file's text contains
one), `contextGlobs` (string[] — files to load into context), `includePackageSpecs` (bool —
auto-load the spec(s) for changed packages).

## Notes

- Pure logic (glob routing, findings parse/dedupe) is unit-tested in `lib/lib.test.mjs` and runs
  in CI like any other package.
- Run before opening a PR: `pnpm run review` (or `--ci` to get a non-zero exit on blocking
  findings). Not wired into pre-push — see the note at the top of this file.
- Cost lives in your existing Claude Code subscription for local/hook runs.
