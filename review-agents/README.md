# Review agents

Specialist Claude Code reviewers that run on the pre-push hook and post findings.
See `docs/specs/dev-harness.md §6` for the full design.

Roster (one dir per specialist, each with `system-prompt.md`, `context-loader`, `examples.md`):

- **contract-guardian** _(blocking)_ — schema breaking-change detection
- **test-auditor** _(blocking)_ — new code paths must have tests
- **spec-adherence** _(informational)_ — code vs. spec drift
- **consistency** _(informational)_ — naming / error / log conventions
- **runtime** _(some blocking)_ — missing error handling, blocking calls, races
- **security** _(blocking)_ — secrets, injection, path traversal, eval

`orchestrator.mjs` decides which specialists are relevant to a diff, runs them in
parallel via Claude Code headless mode, aggregates, and writes
`.review-agents/report-<sha>.json`. Build this after the first few packages exist
(dev-harness §13 step 8 starts with just contract-guardian).
