# Marquee — working agreement

Immersive jukebox: place a tagged record sleeve on the stand → the lights and display become
the record. Systems overview: [docs/specs/runtime-overview.md](docs/specs/runtime-overview.md).
Per-service specs live in [docs/specs/](docs/specs/); ADRs in [docs/adrs/](docs/adrs/).

## Specs are the source of truth — keep them honest

**`docs/specs/` describes the intended behavior of the system. Code and spec must not silently
drift.** When an implementation needs to deviate from a spec:

1. **Discuss it first** — surface the deviation and the tradeoff, don't just quietly diverge.
2. **Record the decision** — add an ADR in `docs/adrs/` (numbered, immutable) capturing context,
   decision, and consequences. Make the `# ADR NNNN` heading match the filename, and cite other ADRs
   as a **link**, not a bare number.

   **Take the next free number from `pnpm run check:adrs`, not from `ls docs/adrs/`** — the
   allocation lives on `origin/main`, and it moves. Four collisions have shipped from `ls`
   ([#151](https://github.com/dylanleatham/Marquee/issues/151),
   [#316](https://github.com/dylanleatham/Marquee/issues/316)); the number belongs to whichever
   decision published it on `main` first. Never re-slug or delete an ADR `main` has published —
   supersede it, because the citations outside this repo can't be swept. `pre-push` enforces this
   ([ADR 0083](docs/adrs/0083-an-adr-number-is-checked-against-origin-main-at-push-time.md)).

3. **Update the affected spec in the same PR** — edit `docs/specs/*.md` so it matches what the
   code actually does. A spec that lies is worse than no spec.

When the `spec-adherence` reviewer flags drift, the right fix is usually "update the spec," not
"revert the code" — but decide it deliberately, per the above.

## Fixing bugs — test-first, close the blind spot

A bug that reached you is also a bug the harness missed. Fix **both**: the defect, and the gap
that let it through. The procedure is test-first — write a test that reproduces the bug and
**watch it fail** before touching the code; a test that never went red proves nothing. File a
GitHub issue, branch `fix/<issue#>-<slug>`, then red → green → widen to the bug's family → name
and close the blind spot. Full workflow:
[docs/specs/bug-fix-workflow.md](docs/specs/bug-fix-workflow.md).

## Definition of done

```bash
pnpm run review    # three reviewers, ~1-2 min
```

Run it **before the first commit**, not as a gate before the PR — it is a linter you answer in the
same session. Everything it knows is on stdout when it finishes: `[FIX ]` lines are blocking,
`[note]` lines are for your judgement. There is nothing to record afterwards.

The bar is **no `[FIX ]` findings left unanswered**, not zero findings. Chasing zero is
gold-plating; disagreeing with a `[note]` and moving on is a normal outcome.

Two rules the reviewers can't fully see, so they're on you:

- **New surface ⇒ test in the same change.** Every new exported function, React component, hook,
  route, or state transition ships with a test. (`test-auditor` flags this — don't make it do so.)
- **New `spawn` / `fetch` / unbounded loop ⇒ bound it.** Anything driving a subprocess, the network,
  or looping on external state gets a timeout or cap — Curator is always-on and a hung call must not
  wedge the event loop. Bound the shared helper so every caller inherits it.

If a finding class shows up twice, that's a blind spot: close it with a durable gate — a test, a
bounded helper — rather than fixing the instance again.

## Conventions

- **Monorepo**: pnpm + turbo, Node 22. `pnpm test` / `pnpm --filter <pkg> test`, `pnpm run type`.
- **Branches**: `feat/*`, `fix/*`, `chore/*` off `main`; Conventional Commits (commitlint-enforced).
  `main` isn't hard-protected (free plan) — the git hooks are the gate; don't commit product code
  straight to `main`.
- **Review agents** run on demand, never in `pre-push`. Three of them, each encoding something a
  generic reviewer can't know about this repo. See
  [review-agents/README.md](review-agents/README.md).
- **Mechanisms, not reminders** — [.claude/](.claude/README.md): `/fix-bug` walks the bug-fix
  procedure including _watch it fail_, `/new-adr` takes the number from `origin/main`, and a Stop
  hook mentions the reviewers when source changed and they never ran.
- **Bugs** are tracked as GitHub issues; the fixing PR `Closes #<n>`.
- `gh` CLI is at `C:\Program Files\GitHub CLI\gh.exe` (authed as `dylanleatham`), not on PATH —
  call it by full path.
