# ADR 0025 — Palette edits are rejected (409) while Roadie is processing an album

Status: accepted · Date: 2026-07-24 · Amends: roadie-spec §15 (Concurrent Curator
writes), curator-spec §Edge cases (Roadie state races)

## Context

`roadie-spec.md` §15 and `curator-spec.md` §Edge cases both say that when a human edits a palette
while Roadie is working the same album, **"human wins (Roadie retries later)"** via a per-album
lock. Implementing per-album palette editing surfaced a gap between that stated design and what the
worker actually guarantees:

- The worker (`roadie/worker.ts`) implements human-wins at **step boundaries**: after each sub-step
  it re-reads the asset (`worker.ts:222`), so an edit landing _between_ steps is honored. But within
  a single sub-step's async execution the worker holds an in-memory copy, and `advance()` persists
  the **whole** asset — so an edit landing _during_ a step would be clobbered when that step's result
  is saved.
- Palette editing requires a palette to exist. The earlier processing states
  (`fresh`/`fetching_metadata`/`downloading_art`/`generating_palette`) have none, so `editPalette`
  already rejects them with a 400 ("palette isn't generated yet"). The **only** contested window is
  `drafting_prompts` — the sub-second final processing step, where the palette exists and the worker
  is drafting prompts from it.

So the specs' "human wins" holds between steps but not during the one sub-step where a palette edit
is both possible and racy.

## Decision

All three palette actions — `editPalette`, `resetPalette`, and `regeneratePalette` — reject with
**409** (`PaletteConflictError`) while the album is in any processing state; the re-extract path also
re-checks the guard **inside** its `store.update` mutator so it holds across its own slow Palette
Press await (issue #38 pattern).

Rationale: fully honoring "human wins" during a sub-step would require the worker to merge a step's
result under a re-read (or hold a real lock) — a broader, riskier change than a palette-editing
feature should carry, and getting it wrong silently loses the human's edit. A clear 409 during a
sub-second window ("still processing — wait for review") is safer and simpler. The human retries at
`awaiting_review`, where editing is unrestricted.

## Consequences

- Deviates from the specs' "human wins" for the `drafting_prompts` window; both spec locations carry
  a dated note pointing here.
- **No data loss:** an edit is either applied (album already at review) or cleanly rejected (409) —
  never silently clobbered.
- The worker's between-steps re-read is unchanged, so edits landing between sub-steps are still
  honored — the deviation is scoped to the single racy sub-step.
- If a true per-album lock or a step-result merge is added later, this guard can relax back toward the
  original "human wins" intent; a superseding ADR would record that.
