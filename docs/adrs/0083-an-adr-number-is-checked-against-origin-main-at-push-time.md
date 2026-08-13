# ADR 0083 — An ADR number is checked against origin/main, at push time

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing. Amends [dev-harness.md](../specs/dev-harness.md) §4 (pre-push gains an
unfiltered first step) and [CLAUDE.md](../../CLAUDE.md) ("Specs are the source of truth" — how to
take the next free number). Builds on
[ADR 0064](0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md), whose CI shape is why the
existing guard runs in exactly one leg.
**Issues:** [#151](https://github.com/dylanleatham/Marquee/issues/151) (the original collision),
[#316](https://github.com/dylanleatham/Marquee/issues/316) (the fourth),
[#317](https://github.com/dylanleatham/Marquee/issues/317) (this guard).

## Context

ADR numbers are allocated by hand from a shared counter, and this is the **fourth** time two
decisions have ended up sharing one:

| when                                                           | numbers    | how it was noticed                                         |
| -------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| [#151](https://github.com/dylanleatham/Marquee/issues/151)     | 0022, 0023 | by hand, after ~74 citations had become ambiguous          |
| [ADR 0065](0065-the-sweep-reports-a-record-it-already-owns.md) | 0064       | `adr-numbering.test.ts` failed on `main`, for every branch |
| `53b39d3`                                                      | 0075, 0076 | same                                                       |
| [#316](https://github.com/dylanleatham/Marquee/issues/316)     | 0077, 0078 | same                                                       |

The fourth is the instructive one. It was **created by the fix for the third**: commit `6f85a8e`
resolved the 0075/0076 collision by renumbering the curator/amp pair up to 0077/0078 — two numbers
that two concurrently-merged Stylus ADRs had just taken on `main`. The collision moved rather than
being resolved, because "the next free number" was read off the branch's own `docs/adrs/` and
`origin/main` was never consulted.

`adr-numbering.test.ts` is a good guard and had nothing to do with any of this, because it could not
run:

- **Its only CI home is `ci.yml`'s `test:unit` leg**, and `CI_ENABLED=false` — set 2026-08-09 for the
  Actions billing block — skips every job in `ci.yml` **and** `nightly.yml`. The whole CI safety net
  has been off for four days.
- **`pre-push` cannot select it.** The hook ran the unit suite affected-only, filtered on
  `...[HEAD^1]`. An ADR is a docs-only change touching no package, so the filter selected
  _nothing_: zero tests ran on the one push that could introduce a collision.

That second point is the durable defect, and it is an exact repeat of a trap `ci.yml` documents and
deliberately avoids — _"A docs-only PR changes no package, so an affected-only filter would run
nothing, and the ADR-numbering guard would go quietly unrun on exactly the PRs it exists to check. A
gate that skips itself is the failure mode this repo keeps having."_ CI learned that lesson in
[ADR 0064](0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md); `pre-push` never did.

There is a third gap that outlives both. Even with CI on, `pull_request` builds PR-head merged into
the main that existed **when the run started**, and nothing re-runs a PR when its base moves —
"require branches to be up to date" needs branch protection, which needs a paid plan. Two branches
each taking 0083 are green apart and collide on merge. That is literally how 0075/0076 happened.

## Decision

**An ADR number is validated against `origin/main`, in `pre-push`, outside the affected-only
filter.**

1. The checks move from `packages/curator/test/adr-numbering.test.ts` into
   `scripts/check-adr-numbers.mjs` — one implementation, no dependencies, ~100ms. The test file
   imports it and remains where the checks are **proven** (its fixture suites are unchanged, and now
   cover the new check too). A hook can enforce; only a test can demonstrate that the enforcement
   works.
2. `.husky/pre-push` runs it **first and unconditionally**. Any future repo-wide guard belongs on the
   same unfiltered line.
3. The script adds `driftFromBaseIn`: a number `origin/main` has already published must name the
   same file here. It fetches `origin/main` first, so a branch that has been open while main moved
   cannot pass on a stale ref.
4. On failure it prints **the next genuinely free number**, computed across both trees. The absence
   of that one number is what turned the third collision into the fourth.
5. `pnpm run check:adrs` runs the same thing on demand.
6. **The citation scan covers every tracked text file**, via `git ls-files` and a denylist of binary
   extensions — not the three globs (`docs` markdown, `packages` TS/TSX, `CLAUDE.md`) it used to.
   Eighteen files cited ADRs from outside that set, and the #316 renumber duly broke a link in
   `packages/stylus/stylus/dispatch.py` while the guard stayed green. The hand sweep had been
   written to match the same three globs, which is the real lesson: a gate that defines its scope
   narrowly teaches the sweep to be narrow too. A denylist means the next file type to cite an ADR
   is covered without anyone remembering to add it.

Two details are deliberate:

- **Re-slugging or deleting a published ADR fails the check**, not just displacing one. ADRs are
  "numbered, immutable, citable"; the citations a rename breaks that no sweep can reach — PR bodies,
  issue comments, review threads — are exactly the cost #151 was filed for. Supersede instead.
- **A number already colliding on the base is exempt.** There is no allocation to preserve, and the
  only fix is to move one of the two — the branch this check would otherwise block. `collisionsIn`
  still has to pass on the result, so the exemption cannot leave a tree broken.

## Consequences

**What this catches that nothing did:** a renumber landing on someone else's ADR (`6f85a8e`, and the
one before it); any ADR pushed while CI is disabled; a rename that breaks a citation, on the push
rather than in a review.

**What it costs:** one `git fetch origin main` per push, inside a hook that is about to contact the
remote anyway. `--local` skips that half, and says so on stdout rather than passing silently.

**What it does not catch — accepted knowingly.** Two branches that both push _before_ either merges.
Closing that needs a gate at merge time, which needs either paid branch protection or a per-merge CI
job; ADR 0064 priced the latter out, and `nightly.yml` already re-runs the whole `test:unit` graph
against `main` once CI is re-enabled. The residual is bounded by the fetch running on every push, and
a merge is normally preceded by one. If a fifth collision happens anyway, that is the evidence that
sequential hand-allocated numbers are the wrong primitive, and the answer becomes collision-free ids
rather than a better check — which would cost a rename of every ADR and ~200 citations, so it wants
that evidence first.

**The rule this encodes, for whoever renumbers next:** the number belongs to whichever decision
published it on `main` first. Both of #316's collisions resolve that way — Stylus keeps 0077 (it
landed in `e11fab0`, before the renumber), the curator/amp demo-cut ADR keeps 0078 (it landed in
`6f85a8e`, before `7a5eb29`), and the two latecomers took 0081 and 0082.
