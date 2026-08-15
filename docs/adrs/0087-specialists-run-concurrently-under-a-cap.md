# ADR 0087 — Specialists run concurrently under a cap

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing. Reverses a deliberate choice recorded in
[review-agents/README.md](../../review-agents/README.md) ("the call is a blocking `spawnSync`, so
specialists run **one at a time**") and amends [dev-harness.md](../specs/dev-harness.md) §6
(orchestration). Implements [harness-self-improvement.md](../specs/harness-self-improvement.md) §4.4,
Phase 4.
**Issues:** none — this is harness latency, not a defect.

## Context

`CLAUDE.md` instructs running the reviewers "**in the inner loop** — before the first commit,
iterating to green — so they act as a linter you answer in the same session, not a gate that bounces
the PR". Nobody does that, and the reason is arithmetic: the per-specialist budgets sum to roughly
twenty minutes worst case across a roster that is now eight.

The orchestrator already looked concurrent. It mapped the specialists through `Promise.all`, but
`runSpecialist` called **`spawnSync`** — a blocking call — so the map executed strictly one at a
time. The code read as parallel and was not, which is its own small hazard: anyone reading it would
have concluded latency was already solved.

The sequential behaviour was not accidental, and the reason it was given is a real one: "gentler on
a loaded machine than N concurrent sessions." That was written when N was six. It is still the right
instinct at eight — a laptop also running four dev services should not have eight Claude Code
processes opened on it at once — but it argues for a **cap**, not for a width of one.

## Decision

**Specialists run concurrently, at most `REVIEW_CONCURRENCY` (default 3) at a time.**

`runSpecialist` becomes promise-returning, built on `child_process.spawn`, and the orchestrator maps
over the roster with a bounded pool (`mapWithConcurrency`).

`spawn` has neither of the two options `spawnSync` provided and this harness depends on, so both are
enforced by hand and the result is normalised back to the `spawnSync` shape:

- **`maxBuffer`** does not exist on `spawn` at all. Accumulated stdout is capped and the child is
  killed past the limit.
- **`timeout`** exists but kills the child without producing the `ETIMEDOUT` code that `interpret`
  and RA-2's retry rule are written against. A timer owns the kill and synthesises the error.

Keeping the `spawnSync` result shape means `interpret`, the retry logic, and every existing retry
test survive unchanged — the injected-spawn fakes needed only an `async` keyword.

**A second tier, `--fast`, runs only the triggered _blocking_ specialists.** It is derived from
`blocking` rather than from a list, so it cannot drift when a reviewer changes severity. The full
roster still runs before the PR, and the run says what it skipped.

## Consequences

**Wall clock, measured on this branch's own 60-file diff** — five triggered specialists, real
sessions, same code, only the pool width differing (`REVIEW_CONCURRENCY=1` reproduces the old
behaviour exactly):

| run                                 | wall clock        |
| ----------------------------------- | ----------------- |
| sequential (`REVIEW_CONCURRENCY=1`) | **366s** (6m 06s) |
| pooled (default 3)                  | **198s** (3m 18s) |

**1.85×.** One machine on one day, so treat the ratio rather than the seconds as the result.

Two things the per-specialist timings show that the totals hide. The sequential run is the sum of
its parts (56 + 122 + 162 + 6 + 5 ≈ 351s); the pooled run is the length of its longest pole —
`doc-coherence` at 197s — so **the speedup is bounded by the slowest specialist, not by the cap**.
Raising `REVIEW_CONCURRENCY` past 3 would buy little here.

And `doc-coherence` itself got _slower_ under contention: 122s sequential, 197s pooled. Concurrency
trades per-specialist latency for total wall clock, which is the right trade for a developer waiting
on the whole run and the wrong one for a single `--reviewer` invocation. That is the case for
keeping the cap modest rather than removing it.

**Making `runSpecialist` async silently broke `parseWithRepair`,** and this is the part worth
remembering. That function called `repair(text)` synchronously and tested `second?.ok`; against a
promise that is `undefined`, so every prose reply would have fallen straight through to
`unrepaired`. RA-4's entire recovery path — the thing that stops a blocking finding written as a
paragraph from failing to block — would have been dead, **and every test would still have passed**,
because the tests injected a synchronous fake. `parseWithRepair` is now async and its tests await.
The general shape: turning one function async breaks every synchronous consumer that reads a field
off the result, and a test suite built on synchronous fakes cannot see it.

**Ordering is preserved.** `mapWithConcurrency` writes results by index, because the orchestrator
zips runs back to specialists positionally and the eval scores per case — a slow item landing in a
fast item's slot would corrupt both silently.

**Console output now interleaves.** Per-specialist lines print as each finishes rather than in
roster order, which reads as progress rather than as a stall.

**The eval cannot validate this change, and should not be asked to.** It caches on a specialist's
prompt, examples, config and model — none of which move here — so a post-change run is a cache hit
that proves nothing, and `--no-cache` would re-sample a process whose measured run-to-run variance
(33–50%) dwarfs any effect this could have. The instruments that do apply are the unit tests for the
pool and retry semantics, and the wall clock.
