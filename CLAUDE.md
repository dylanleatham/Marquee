# Marquee — working agreement

Immersive jukebox: place a tagged record sleeve on the stand → the lights and display become
the record. Systems overview: [docs/specs/runtime-overview.md](docs/specs/runtime-overview.md).
Per-service specs live in [docs/specs/](docs/specs/); ADRs in [docs/adrs/](docs/adrs/).

## Specs are the source of truth — keep them honest

**`docs/specs/` describes the intended behavior of the system. Code and spec must not silently
drift.** When an implementation needs to deviate from a spec:

1. **Discuss it first** — surface the deviation and the tradeoff, don't just quietly diverge.
2. **Record the decision** — add an ADR in `docs/adrs/` (numbered, immutable) capturing context,
   decision, and consequences.
3. **Update the affected spec in the same PR** — edit `docs/specs/*.md` so it matches what the
   code actually does (a dated note that points to the ADR is enough; supersede, don't delete
   the history). A spec that lies is worse than no spec.

The Spec Adherence review agent flags code/spec drift; the correct resolution is usually "update
the spec," not "revert the code" — but that's a decision to make deliberately, per the above.

Precedent: [ADR 0002](docs/adrs/0002-hue-conductor-v4-and-dev-auth.md) (Conductor on node-hue-api
v4), [ADR 0003](docs/adrs/0003-palette-press-dominant-first-ordering.md) (Palette Press
dominant-first ordering) — both have matching spec updates.

## Conventions

- **Monorepo**: pnpm + turbo, Node 22. `pnpm test` / `pnpm --filter <pkg> test`, `pnpm run type`.
- **Branches**: `feat/*`, `fix/*`, `chore/*` off `main`; Conventional Commits (commitlint-enforced).
  `main` isn't hard-protected (free plan) — the git hooks are the gate; don't commit product code
  straight to `main`.
- **Review agents** run on demand: `pnpm run review` before opening a PR (not in pre-push). See
  [review-agents/README.md](review-agents/README.md) and `review-agents/KNOWN-ISSUES.md`.
- `gh` CLI is not installed; use PR links / the Actions tab.
