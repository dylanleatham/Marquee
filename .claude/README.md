# `.claude/` — the workflow, as mechanism rather than prose

CLAUDE.md states how work happens in this repo: the bug-fix procedure, how ADR numbers are
allocated, that the reviewers belong in the inner loop. All of it was prose a session had to read
and remember to obey — and the gap between a documented rule and an executed one is measurable:
**four ADR collisions shipped while `pnpm run check:adrs` existed and was correct.**

This directory closes some of that gap. It is committed on purpose; it is part of the harness.

| path                     | what it is                                                            |
| ------------------------ | --------------------------------------------------------------------- |
| `skills/fix-bug/`        | `/fix-bug` — the bug-fix workflow, with _watch it fail_ made explicit |
| `skills/new-adr/`        | `/new-adr` — takes the number from `origin/main`, never from `ls`     |
| `hooks/review-nudge.mjs` | Stop hook: source changed, reviewers never ran                        |
| `settings.json`          | wires the hook                                                        |
| `worktrees/`             | Claude Code's own worktrees — **gitignored**                          |

## The hook is a nudge, and stays one

`review-nudge.mjs` always exits 0 and never blocks. It prints three lines when reviewable source has
changed since the last review report, and says nothing otherwise — including when it is run outside
a git repo, where it swallows git's own stderr rather than printing `fatal: not a git repository` at
the end of every session.

That restraint is the design. A hook that gates every session is how people learn to work around the
harness, and this repo already has a `--no-verify` shaped hole waiting for exactly that. The
reviewers are deliberately not in `pre-push` for the same reason.

## Editing these

A skill is documentation that gets executed, so it drifts like documentation. When you change how
something works, grep here too — `spec-adherence` reviews `*.md` anywhere in the tree, including
this directory, but it detects about half the time, so do the grep.
