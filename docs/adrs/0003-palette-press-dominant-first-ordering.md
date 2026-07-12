# ADR 0003 — Palette Press orders dominant-color-first, not vibrant-first

Status: accepted · Date: 2026-07-11 · Supersedes: palette-press-spec §6 (Step 3 ordering)

## Context

`palette-press-spec.md` §6 step 3 assigns roles by a **fixed preference order** — node-vibrant's
`Vibrant` (most-saturated) swatch always becomes `primary`. Implementing that literally against
the real fixture covers failed the spec's own goals:

- **§2 success criteria** say Purple Rain must be "dominated by purple" and Kind of Blue "by
  blue." With vibrant-first, Purple Rain's `primary` came out **orange** (its most-saturated
  pixel is a warm highlight) and Kind of Blue's came out **tan**.
- The **integration contract's Purple Rain reference payload** lists `primary = #4B0082` sourced
  from **DarkVibrant**, not Vibrant — so the canonical example already contradicts §6.

The spec is internally inconsistent: §6 (algorithm) disagrees with §2 (goal) and the reference
payload (example).

## Decision

Order surviving colors **dominant-color-first**: by node-vibrant pixel **population**, considered
only **among the sufficiently-colorful swatches** (chroma ≥ `orderColorFloor`, default 0.2), then
assign roles by final position. A dull high-population background therefore can't outrank the
album's signature color, and a small vivid highlight can't beat the dominant mood color.

We optimized for the spec's _goal_ (§2 + the reference payload) over its _stated algorithm_ (§6).
All thresholds (`orderColorFloor`, `monochromeChroma`, `hueSpreadDeg`, the floors) are exposed
`PostProcessOptions` so Curator can override per-album. Monochrome detection was also strengthened
(chroma floor + hue-spread arc) so near-black/near-white/single-hue art returns `insufficient`.

## Consequences

- All 8 fixture covers now meet the success criteria: Purple Rain → purple, Kind of Blue → blue,
  Black/White/Unknown Pleasures → `insufficient(monochrome)`.
- It's a heuristic; an untested album could still lead with a debatable color — the per-album
  overrides and the human `awaiting_review` step are the backstop.
- `palette-press-spec.md` §6 was updated to describe dominant-first ordering and point here.
- When populations aren't supplied, the code falls back to the original fixed preference order,
  so the lower-level `postProcessPalette(swatches, options)` contract is unchanged.
