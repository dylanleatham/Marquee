# ADR 0086 — A specialist may be given context found by search

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing. Amends [dev-harness.md](../specs/dev-harness.md) §6 (the roster gains two
specialists, and routing gains a third way to select context) and
[review-agents/README.md](../../review-agents/README.md) (the `config.json` field list). Builds on
[ADR 0085](0085-a-harness-edit-is-validated-against-a-frozen-case-set.md), whose case set is how the
two new reviewers were specified before they were written.
**Issues:** [#236](https://github.com/dylanleatham/Marquee/issues/236),
[#260](https://github.com/dylanleatham/Marquee/issues/260),
[#282](https://github.com/dylanleatham/Marquee/issues/282) (documentation fact-drift);
[#180](https://github.com/dylanleatham/Marquee/issues/180),
[#217](https://github.com/dylanleatham/Marquee/issues/217),
[#223](https://github.com/dylanleatham/Marquee/issues/223),
[#283](https://github.com/dylanleatham/Marquee/issues/283) (checks that went quiet);
[#192](https://github.com/dylanleatham/Marquee/issues/192) (why routing is tested from disk).

## Context

Sorting every `fix(...)` commit on `main` by "which reviewer should have caught this" leaves two
large classes with no reviewer at all.

**Documentation fact-drift** is the most frequent. Four ADR number collisions; the Pi 5's address
documented in two places and then in three (#260), after an earlier fix had already "corrected" it
to two (#243); six source files citing ADR 0016 for a Discogs decision that is 0017 (#236); §7 of
`dev-harness.md` describing branch-protection settings as configured when they were not and could
not be (#282). `CLAUDE.md` states the rule — _changed a documented fact ⇒ reconcile every copy of
it_ — and `spec-adherence` only watches code↔spec drift. Nothing watched doc↔doc drift.

**Checks that go quiet** is the most dangerous. `node --test` finding zero files and exiting 0
(#283); CI never installing ffmpeg so every real-binary test skipped itself (#180, #217); turbo's
strict env mode dropping `VITEST_MAX_FORKS` so the fork cap never reached vitest (#223). Each was
green throughout. §11 elevated this to a standing rule and enforces it with three bespoke tests
guarding the three holes that already opened; nothing asks the question of a **new** check.

Adding `null-result` for the second class is unremarkable — its context is a fixed glob. `doc-coherence`
is not, and that is what needs a decision. Its question is _"which other copies of this fact are now
wrong?"_, and the answer is "whichever of 80-plus ADRs and 17 specs happen to mention what this diff
touched". That is a search. Every existing specialist reads context named in advance by
`contextGlobs`, and no fixed glob can express it: loading all of `docs/` would be most of the repo.

## Decision

**Add `null-result` (blocking) and `doc-coherence` (info), and give routing a third way to select
context: `contextRelated`, resolved by keyword overlap.**

```jsonc
"contextRelated": {
  "over": ["docs/**/*.md", "*.md", "packages/**/*.md"],
  "maxFiles": 6,
  "maxBytes": 100000
}
```

Keywords come from the diff's changed lines plus the changed paths; candidate files are scored by
how many **distinct** keywords they contain, and the best are appended to the prompt under a
`# Possibly related` heading — labelled differently from `# Context:` on purpose, because a reviewer
told a file is "possibly related" hedges where one told it is "the context" would not.

The rejected alternative was **letting the specialist grep for itself**. Each reviewer is a real
headless Claude Code session in the repo, so it could. Cheaper to build, and rejected on three
counts: it makes one reviewer tool-using while every other reads a fixed prompt, so they stop being
comparable (**withdrawn 2026-08-14 — see below**); it puts an unbounded amount of work behind a fixed timeout; and the context becomes
invisible to `--explain`, which is how false positives are diagnosed today. _Amended 2026-08-14: they do have tools._ `consistency` was observed citing three exact line numbers
from a file in neither its diff nor any context glob. So the comparability argument above is
**withdrawn** — the specialists were never non-tool-using. The other two reasons stand on their own
and are why this decision does not change: an unbounded grep still sits behind a fixed timeout, and
context resolved by the orchestrator stays visible to `--explain`, which is how a false positive gets
diagnosed. What does change is what a _case_ means; see review-agents/eval/README.md.

Two constraints on the implementation, both load-bearing:

- **Bounded on four axes** — candidates scanned, bytes read per file, files returned, total bytes.
  This is the only place in the harness that reads files nobody named in advance, and CLAUDE.md's
  rule about unbounded loops applies to it directly.
- **Deterministic.** Same tree, same selection, same order. The eval's cache key covers a
  specialist's config and prompt; if context selection could reshuffle between runs, a cached result
  would be meaningless and a re-ordering could read as a regression.

`doc-coherence` ships **info**, not blocking. Promotion waits on ledger evidence that its precision
holds, which is [ADR-less §4.1](../specs/harness-self-improvement.md) paying for itself.

## Consequences

**Two more sessions on a triggering run.** Both have narrow triggers — `null-result` fires only on
workflows, manifests, task config and test setup; `doc-coherence` on documentation, plus any file
that cites an ADR. That last route exists because #236 was a documentation defect living in six
`.ts` files, which no `docs/**` glob would ever have selected.

**Routing is tested from disk, not asserted.** Two tests discover every workflow and every
test-script `package.json` in the tree and fail if `null-result`'s globs miss one. That is RA-5
(#192) applied to a new reviewer instead of re-learned on it: a _blocking_ specialist that is never
triggered emits no findings and no `[GAP]` warning, so the run reads as a clean pass. A third test
asserts `null-result` does **not** match ordinary product source, because a reviewer that fires on
everything is a reviewer whose findings get skimmed.

**The cases came first.** Five eval cases were written and committed before either reviewer existed,
and scored `not-installed` — which is why that outcome exists (ADR 0085). This is the bug-fix
workflow's red-before-green applied to a reviewer: one whose cases never went red proves nothing.

**Expect inconsistency, not blindness.** The measured behaviour of the existing roster is a
detection rate near 40–50% per run, with zero false positives on clean diffs. There is no reason to
think two new prompts escape that, so their value should be judged on detection rate over repeats,
not on whether a single run catches a case.

**`contextRelated` is a heuristic, and will sometimes select nothing useful.** The examples tell
`doc-coherence` that a related file which merely shares vocabulary is the normal case and not a
finding. If it turns out to speculate anyway, the fix is its prompt or its retirement under §12 —
both of which the ledger and the eval can now support.
