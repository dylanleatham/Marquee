# ADR 0001 — pnpm monorepo with a contracts-first test harness

Status: accepted · Date: 2026-07-10

## Context

Marquee is five services (one in Python) that share contracts and fakes. The specs
(`dev-harness.md`, `testing-strategy.md`) call for a monorepo where shared contracts and
fakes are the first-class deliverable, so tests become cheap to write.

## Decision

- **Monorepo** managed by `pnpm` workspaces + `turbo` for cached, affected-only builds.
- **`packages/contracts`** holds versioned JSON schemas; TS types are generated from them;
  the Python service (`packages/stylus`) validates against the same raw `.json`.
- **Contract tests are the top gate** — fastest CI job, blocks everything else.
- **Node 20** pinned via `.nvmrc`; **Python 3.11+** for Stylus.
- Python service folder named `stylus` (committed service name) rather than the doc's
  sketch `nfc-trigger`.

## Consequences

- One `pnpm install` wires every Node package; the Python package stands apart with its own
  `pyproject.toml` (not a pnpm workspace member).
- Hardware-only Python deps (adafruit/pn532) don't install off-Pi; CI installs test tooling
  only and runs pure-logic tests.
- Adding a new boundary = add a schema + validators on both sides; the pattern is uniform.
