# ADR 0090 — Context is selected by section, not by the first 16KB

**Date:** 2026-08-15
**Status:** Accepted
**Supersedes:** nothing. Amends [dev-harness.md](../specs/dev-harness.md) §6 (what a specialist
reads) and [review-agents/README.md](../../review-agents/README.md). Reuses the keyword scoring from
[ADR 0086](0086-a-specialist-may-be-given-context-found-by-search.md), applied at section rather than
file granularity, and is gated by
[ADR 0085](0085-a-harness-edit-is-validated-against-a-frozen-case-set.md).
**Issues:** [#325](https://github.com/dylanleatham/Marquee/issues/325).

## Context

`readTruncated` capped every context file at 16KB by taking its front. On a single
`packages/curator/src/**` change, `spec-adherence` received four truncated specs — `curator-spec.md`
at **7%** of its 227,982 bytes, plus `roadie-spec.md`, `runtime-overview.md` and
`album-onboarding-workflow.md`. `test-auditor` lost about half of `testing-strategy.md` the same way.

The severity is not the volume, it is _which_ 16KB. Of `curator-spec.md`'s sections, ten survived,
and the first one lost was `## 8. HTTP API` — the section a reviewer needs to check `server.ts`
against. The front of a spec is its title, its layout and its scope; the behaviour is further down.
So the reviewer whose entire job is code-versus-spec drift had been reading the parts of the spec
least likely to describe what the code does, since the harness was built.

It was found while diagnosing why `null-result` scored 0/9: it loaded `dev-harness.md` for §11's
rule, which begins at byte 41,156 of a 48,771-byte file. The sentence it existed to apply never
arrived.

## Decision

**Split a context document into heading blocks, score each against keywords taken from the diff, and
spend the same 16KB on the best of them.**

The budget does not move. `CONTEXT_BUDGET_BYTES` stays at 16,000; `CONTEXT_READ_BYTES` (400KB) is
only how much is read before choosing, because the choosing cannot see past the cap it is meant to
replace.

Two alternatives were rejected:

- **Raise the cap.** Curator's four specs whole are ~330KB per review, roughly 80k tokens, on a
  reviewer already carrying a 300s budget. That trades a silent gap for a bill and a timeout.
- **Let the reviewer read the file.** Specialists do have file access, and the truncation marker does
  reach the prompt, so one _could_. Nothing tells it which part is missing or that the missing part
  is the relevant one, and a reviewer that has to notice and go looking is not a mechanism.

Three details that are load-bearing rather than incidental:

1. **Fenced blocks are not headings.** `# push_assets = false` inside a TOML example was being parsed
   as a section boundary. Ten of `curator-spec.md`'s 54 "sections" were code comments, which tore
   config examples away from the prose explaining them.
2. **A subsection carries its parent heading.** `### Inventory (adding and removing albums)` means
   something different once you know it sits under `## 8. HTTP API`, so the parent is emitted even
   when its body is not.
3. **Omissions are stated.** `… 7 section(s) omitted as unrelated to this change …` rather than a
   file that simply stops. A reviewer cannot reason about a gap whose shape it cannot see, and this
   one _can_ go and read the rest.

## Consequences

**Measured, not assumed.** The three specialists whose context this changes, re-run at `--repeat 5`
with the cache genuinely cold:

| specialist          | before           | after           |
| ------------------- | ---------------- | --------------- |
| `spec-adherence`    | 5/5, 0/5 FP      | **5/5, 0/5 FP** |
| `contract-guardian` | 3/3 (diagnostic) | **5/5, 0/5 FP** |
| `test-auditor`      | 4/5              | **3/5**         |

`spec-adherence` loads three of the four affected specs and is unmoved. `test-auditor` lost one run
of five. That is inside the gate's sampling tolerance — two standard errors of a baseline rate of
0.8 over five runs is ±0.36, and the observed drop is 0.2 — so it does not register as a regression,
and **at n=5 it cannot be distinguished from noise either way**. It is recorded rather than
explained. If it is real it is small, and the reviewer now reads the relevant half of
`testing-strategy.md` instead of its first half.

`contract-guardian`'s baseline row (0/5) belonged to a case since reassigned to `consistency`, so
there is nothing to compare it against; 5/5 is a fresh measurement of the case that replaced it.

**The eval's cache was blind to this, and now is not.** `cacheKey` hashed the case, the patch, the
prompt, the examples, the model and the config — every one of them a _proxy_ for what a reviewer
reads. It did not hash the context. So the first attempt to gate this change replayed cached verdicts
for inputs the reviewer had never seen, and would have reported no regression without running
anything. The key now includes the assembled context, which is exact because `buildContext` is
deterministic.

That fix **invalidates the entire existing cache**, so the next full baseline is ~100 real sessions
rather than the ~35 it would have been. That is the price of the previous baseline having been
partly unverifiable, and it is worth paying once.

**Selection is a heuristic, and will sometimes choose badly.** Scoring is distinct-keyword overlap
with a bonus for heading matches — the same notion of "related" as `contextRelated`, deliberately, so
there is one definition to reason about. A change whose diff shares no vocabulary with the section
that governs it will still miss, and the fallback with no keywords is the front of the document,
which is the old behaviour. The `[CTX ]` warning stays for exactly this reason: reduced context is
still worth knowing about, even when the reduction is now a choice rather than an accident.
