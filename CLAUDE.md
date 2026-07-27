# Marquee — working agreement

Immersive jukebox: place a tagged record sleeve on the stand → the lights and display become
the record. Systems overview: [docs/specs/runtime-overview.md](docs/specs/runtime-overview.md).
Per-service specs live in [docs/specs/](docs/specs/); ADRs in [docs/adrs/](docs/adrs/).

## Specs are the source of truth — keep them honest

**`docs/specs/` describes the intended behavior of the system. Code and spec must not silently
drift.** When an implementation needs to deviate from a spec:

1. **Discuss it first** — surface the deviation and the tradeoff, don't just quietly diverge.
2. **Record the decision** — add an ADR in `docs/adrs/` (numbered, immutable) capturing context,
   decision, and consequences. **Take the next free number and cite ADRs by filename link, not a
   bare "ADR 0022"** — parallel branches each grabbing "the next number" collided three times
   (0022, 0023, 0026) before anyone noticed, which left ~74 bare citations pointing at a number that
   named two different decisions ([#151](https://github.com/dylanleatham/Marquee/issues/151)).
   `scripts/check-adr-numbers.mjs` now fails the commit on a duplicate or a heading/filename
   mismatch; `contract-tests/adr-numbers.test.mjs` is the CI gate.
3. **Update the affected spec in the same PR** — edit `docs/specs/*.md` so it matches what the
   code actually does (a dated note that points to the ADR is enough; supersede, don't delete
   the history). A spec that lies is worse than no spec.

The Spec Adherence review agent flags code/spec drift; the correct resolution is usually "update
the spec," not "revert the code" — but that's a decision to make deliberately, per the above.

Precedent: [ADR 0002](docs/adrs/0002-hue-conductor-v4-and-dev-auth.md) (Conductor on node-hue-api
v4), [ADR 0003](docs/adrs/0003-palette-press-dominant-first-ordering.md) (Palette Press
dominant-first ordering) — both have matching spec updates.

## Fixing bugs — test-first, close the blind spot

A bug that reached you is also a bug the harness missed. Fix **both**: the defect, and the gap
that let it through. The procedure is test-first — write a test that reproduces the bug and
**watch it fail** before touching the code; a test that never went red proves nothing. File a
GitHub issue, branch `fix/<issue#>-<slug>`, then red → green → widen to the bug's family → name
and close the blind spot (test, contract, property, or reviewer rule). Full workflow:
[docs/specs/bug-fix-workflow.md](docs/specs/bug-fix-workflow.md).

## Definition of done — close the loop before review, not after

The review agents (`pnpm run review`) encode a checklist the repo already expects. Run them **in the
inner loop** — before the first commit, iterating to green — so they act as a linter you answer in
the same session, not a gate that bounces the PR. Only genuinely-debatable calls should reach human
review. The bar is **no blocking findings and no _repeat_ class**, not zero findings (chasing zero is
gold-plating).

Three checks close most of what otherwise slips through — each is the durable fix for a finding that
has recurred:

- **New surface ⇒ test in the same change.** Every new exported function, React component, hook,
  route, or state transition ships with a test. Grep your own diff for new
  `export` / `use…` / `…Section` / route registrations and cross-check the test files. (test-auditor
  flags this — don't make it do so.)
- **New `spawn` / `fetch` / unbounded loop ⇒ bound it.** Anything that drives a subprocess, the
  network, or loops on external state gets a timeout or cap — Curator is an always-on service and a
  hung call must not wedge the event loop. Prefer bounding the shared helper so every caller inherits
  it. (runtime flags this.)
- **Changed a documented fact ⇒ reconcile every copy of it.** A fact usually lives in more than one
  place — a table, prose, an out-of-scope list, an ADR, an onboarding walkthrough. After editing any
  `docs/**`, grep for the feature's keywords **and** status words (`deferred`, `out of scope`,
  `TODO`, the old field/route name) and fix every hit. A spec that lies is worse than no spec (see
  "Specs are the source of truth").

This is the "close the blind spot" rule from the bug-fix workflow applied to review: a finding that
shows up twice is a blind spot — close it with a durable gate (a test, a bounded helper, a
doc-reconcile pass), don't just fix the instance.

## Conventions

- **Monorepo**: pnpm + turbo, Node 22. `pnpm test` / `pnpm --filter <pkg> test`, `pnpm run type`.
- **Branches**: `feat/*`, `fix/*`, `chore/*` off `main`; Conventional Commits (commitlint-enforced).
  `main` isn't hard-protected (free plan) — the git hooks are the gate; don't commit product code
  straight to `main`.
- **Review agents** run on demand: `pnpm run review` — run it early and iteratively, not just before
  the PR (see "Definition of done" above); not in pre-push. See
  [review-agents/README.md](review-agents/README.md) and `review-agents/KNOWN-ISSUES.md`.
- **Bugs** are tracked as GitHub issues; the fixing PR `Closes #<n>`. See the bug-fix workflow above.
- `gh` CLI is installed at `C:\Program Files\GitHub CLI\gh.exe` (authed as `dylanleatham`), but not
  yet on the shell PATH — call it by full path, or use PR links / the Actions tab.
