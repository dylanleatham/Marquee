# ADR 0089 — The retro proposes, and a human accepts

> **Superseded 2026-08-16 by [ADR 0092](0092-the-harness-is-three-reviewers-and-one-command.md).**
> `pnpm run review:retro` and the ledger it reads are deleted. The measurement recorded here is not disputed; what changed is that the harness it served
> was cut to three reviewers and one command, and this machinery cost more attention than the
> reviewers it governed. The code is in git history at `af1dde0`.

**Date:** 2026-08-14
**Status:** Accepted
**Supersedes:** nothing. Completes `harness-self-improvement.md` (deleted 2026-08-16 by [ADR 0092](0092-the-harness-is-three-reviewers-and-one-command.md); in git history at `af1dde0`)
§4.6 and gives [dev-harness.md](../specs/dev-harness.md) §12 a mechanism. Depends on
[ADR 0085](0085-a-harness-edit-is-validated-against-a-frozen-case-set.md) — the eval is the
validation half that makes a wrong proposal harmless.

## Context

dev-harness §12 has always described a loop: add checks when a bug ships, delete them when they
generate more noise than signal. Phase 1 built the ledger that records whether a finding was right,
and Phase 2 built the eval that scores the roster. Both produce evidence, and until now nothing read
it back. The loop was a paragraph.

The obvious next step is an agent that reads the evidence and edits the prompts. That is the shape
[Self-Harness](https://arxiv.org/html/2606.09498v1) describes — mine weaknesses, propose bounded
edits, validate against a regression set — and it is also the shape with the sharpest failure mode.
A tool that both judges the reviewers and rewrites them is marking its own homework, and its
characteristic failure is not a bad edit but a **drifting standard**: the criteria move to match what
the tool already produces, and nothing external notices because the tool is what reports.

## Decision

**`pnpm run review:retro` reads the ledger, the escaped-bug commits, the eval baseline and the case
set, and writes one markdown file of proposals. It changes nothing else.**

A test asserts exactly that: it runs the retro and compares `git status --porcelain` before and
after, byte for byte. The propose/accept split is the whole design, not a first-version limitation
to be removed later.

Six proposal kinds, each grounded in something already recorded:

| kind                | fires when                                                                |
| ------------------- | ------------------------------------------------------------------------- |
| `close-a-gap`       | a finding class was **accepted** ≥2 times — the codebase keeps doing it   |
| `fix-a-prompt`      | a class was **wrong** ≥2 times, or a reviewer's precision is under 50%    |
| `add-a-case`        | a `fix(...)` commit has no eval case; a specialist has no coverage at all |
| `verify-a-reviewer` | a reviewer has run ≥5 times and never fired                               |
| `re-measure`        | the baseline is older than 14 days, or none exists                        |

The `accepted` / `wrong` split is what makes the first two different proposals rather than one. A
class that keeps being **accepted** means the reviewer keeps being right and the durable fix is a
gate — closing it with a test is better than catching it a fourth time. A class that keeps being
**wrong** is the reviewer's own problem and is what §12's delete rule exists for. One undifferentiated
"repeat" count could not tell those apart, which is why the ledger types its verdicts at all.

## Consequences

**The accept step stays human, and so does the blame.** A proposal can be wrong at no cost — it is a
file someone reads — and any change made from it still has to pass the eval against the committed
baseline. That asymmetry is what lets the retro be aggressive about proposing.

**`re-measure` exists because a baseline was observed to rot in a day.** `null-result` scored 0/9 on
2026-08-13 and 16/20 on 2026-08-14 with no change to its prompt or config, and the mechanical
explanation (stdin truncation in the pre-[ADR 0087](0087-specialists-run-concurrently-under-a-cap.md)
spawn path) was tested and refuted. Whatever moved, a recorded floor has a shelf life, and a gate
comparing today against a month-old number is comparing against a different world. Fourteen days is
a guess, and it is written down as one.

**Absent evidence is not evidence.** The first version counted must-not-find cases from a baseline
that did not exist, got zero, and proposed "only 0 must-not-find cases in the whole suite" — a
finding manufactured out of missing data, which is the precise failure this whole document is about,
committed by the tool meant to watch for it. No baseline now gets its own proposal, and a test pins
the distinction.

**An empty retro reads as empty, not as clean.** The file says so in as many words, because "no
proposals" and "no evidence to make proposals from" look identical and only one of them is good news.

**It says nothing about `.claude/`.** The skills and the Stop hook that landed alongside it are
workflow ergonomics, not part of this loop — they move rules that were already written down in
CLAUDE.md from prose a session must remember into a mechanism it is handed. The Stop hook is
explicitly a nudge that always exits 0: a gate on every session is how people learn to work around
the harness, and this repo already has a `--no-verify` shaped hole waiting for that.
