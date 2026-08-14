# ADR 0088 — A review samples each specialist and unions the findings

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing, but **replaces the intervention proposed in**
[harness-self-improvement.md](../specs/harness-self-improvement.md) §4.5 (refute-or-promote), which
measurement contradicted before it was built. Builds on
[ADR 0085](0085-a-harness-edit-is-validated-against-a-frozen-case-set.md) (the eval that measured
this) and [ADR 0087](0087-specialists-run-concurrently-under-a-cap.md) (the concurrency that makes
it affordable).

## Context

§4.5 proposed **refute-or-promote**: before a blocking finding gates, a second session tries to
refute it. The premise was that false positives are what erode trust in a gate, which is true in
general and false here.

The eval measured the roster, and the numbers point the other way:

- **False positives: zero.** Not one blocking finding on a clean diff, across every `must-not-find`
  case, at both the case and the run resolution (0/3 cases, 0/15 runs).
- **Recall: 33–50% per run.** And crucially the misses are not blindness. The cases land at 2/5,
  2/5, 2/5 and 4/5 — never 0/5. The reviewers recognise these bugs and simply fail to mention them
  most of the time.

A pass that can only ever _remove_ findings is aimed at the half of the problem that does not exist.
§4.5's own acceptance criterion — "no recall loss and a **measurable FP drop**" — was unsatisfiable
before a line was written, because there is nothing below zero to drop to.

## Decision

**Each triggered specialist runs `REVIEW_SAMPLES` times (default 3) and its findings are unioned.**

The union is not a vote. One run noticing the bug is enough for it to reach the report, which is
precisely what a majority would discard. `dedupe` collapses the overlap and keeps a blocking
duplicate over an info one, so a finding raised as blocking by a single sample still blocks.

The eval gained `--aggregate union` to measure exactly this. Because both aggregations are pure
functions of `hits` and `runs`, and the cache stores those rather than a verdict, **the mode is
chosen after the sessions are spent** — the measurement below cost nothing to produce:

| `runtime`, same five cached runs per case | recall  |
| ----------------------------------------- | ------- |
| majority (previous behaviour)             | **1/4** |
| union                                     | **4/4** |

False positives stayed at 0/2 in the same comparison, because every run on both clean cases was
quiet, so their union is quiet too.

Three samples rather than five: the gain is front-loaded (at ~40% per run, three samples reach ~78%)
and this multiplies the token cost of every review. `REVIEW_SAMPLES=1` restores single-sampling.

## Consequences

**The evidence under this decision is now in doubt, and the ADR is left standing anyway.** On
2026-08-14 `null-result` scored 16/20 (80% per-run) on cases it had scored 0/9 on the day before,
with no commit touching its prompt or config in between. Every measurement behind the 33–50% figure
quoted above predates [ADR 0087](0087-specialists-run-concurrently-under-a-cap.md)'s spawn rewrite;
every measurement since is higher. If the old `spawnSync` path was truncating large stdin on Windows
— and `null-result` has the longest prompt on the roster — then the detection rate this decision was
argued from was measuring a delivery bug rather than the reviewers.

Sampling-and-union does no harm if the true rate is 80% (it costs sessions and adds findings that a
single run would have surfaced anyway), so this is not withdrawn. But **`REVIEW_SAMPLES=3` should be
re-justified once that is resolved**, and if the reviewers were always this good, the right default
is probably 1. See review-agents/eval/README.md for the open question.

**A review costs 3× the sessions.** Reviews are on-demand — they are deliberately not in `pre-push`
— so this is a cost on a command someone chose to run, and ADR 0087's 1.85× wall-clock improvement
partly absorbs it. The run states its session count in the header rather than leaving it to be
inferred from the bill.

**Union buys recall _with_ false positives, and the eval scores that honestly.** A `must-not-find`
case counts as clean only when every run stayed quiet, because a union collects each run's noise as
well as each run's signal. Scoring it any other way would advertise the recall and hide the cost.

**The false-positive evidence is thin.** Zero across three `must-not-find` cases is three cases, not
a rate — and union is exactly the change that would turn a rare per-run false positive into a
frequent per-review one. Widening that side of the case set is the prerequisite for trusting this
decision, and it is not done.

**RA-3 survives sampling.** A specialist counts as having run if _any_ sample did; all samples
failing is `unavailable`, which still suppresses the clean-review message and fails `--ci`. Sampling
must not turn "produced no verdict" into a quiet pass because one attempt of three came back empty.

**The `test-auditor` half of this phase was smaller than planned.** §4.5 proposed adding a
hermeticity rule; the prompt already carried two of the five — literal dates against a real clock
(#244) and ambient machine state (#32). Only the network, fixed shared paths, and inter-test order
dependence were genuinely missing. The plan assumed a gap that was mostly already closed, which is
an argument for reading a prompt before proposing an extension to it.
