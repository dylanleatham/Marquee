# ADR 0033 — Pattern selection is energy-aware, driven by the palette (not Spotify)

Status: accepted · Renumbered from 0022 on 2026-07-27 ([#151](https://github.com/dylanleatham/Marquee/issues/151): 0022 had been allocated twice) · Date: 2026-07-23 · Supersedes: palette-press-spec §7 (size-only pattern
selection) and the "no audio features" framing in palette-press-spec §3, roadie-spec, curator-spec

## Context

Every album drove the lights the same way: `selectDefaultPattern` chose a pattern from palette
**size** alone (1 → `static`, 2+ → `crossfade`), so all three sufficient fixture covers — Purple
Rain, Kind of Blue, Rumours — produced the _identical_ 12000/45000 crossfade. Placing any record on
the stand looked the same as any other. The specs frame the obvious fix, audio-feature-driven
selection, as out of scope because **Spotify deprecated its audio-features endpoint** — leaving
`meta.audioFeatures` defined in the integration contract but populated and consumed by nothing.

The desired behavior is livelier, per-record light shows — motion, not just a slow colour fade —
without resurrecting a dependency that no longer exists.

## Decision

Make pattern selection **energy-aware**, with energy read from the **palette itself**:

- A pure `paletteEnergy(colors)` scores how vivid a palette reads on the wall — a blend of mean HSV
  saturation (0.55) and brightness (0.45), 0..1. This is always available and ties motion directly
  to the album _art_, which is the actual product goal ("lights syncing to the album art").
- `selectDefaultPattern` now returns lively patterns for vivid palettes and keeps the calm
  historical defaults for muted ones:
  - **2+ colours, energy ≥ 0.62** → `rotate` (palette walks around the room), interval scaled by
    energy (≈1600ms at threshold → 700ms at max), floored at 400ms for the rate limiter.
  - **1 colour, energy ≥ 0.66** → `pulse` (breathes), period + brightness swing scaled by energy.
  - Otherwise → the existing `crossfade` (2+) / `static` (≤1) defaults, byte-for-byte unchanged.
- **`meta.audioFeatures` is honoured as an override when present** but never required. A supplied
  `energy` replaces the palette read; a supplied `tempo` (BPM) tempo-locks the motion by snapping the
  interval/period to the nearest whole-beat multiple. Absent (the common case today), the palette
  drives everything. **Automatic fetching of audio features from Spotify stays out of scope** — the
  only sources are hand-authored metadata or a future local analyzer.
- **Insufficient palettes stay `static`.** Their colours were saturation-boosted to floors during
  post-processing, so their "energy" is synthesized, not a real read of the art — not something to
  animate off of. (This holds even if `audioFeatures.energy` is supplied; the human tunes it in
  review.)

This lives in Palette Press's pattern-selection function, the seam §7 always named for richer
signals. It is **producer-side**: Hue Conductor already renders all four pattern types, so nothing
in the Conductor changes — the contract's ownership split (Palette Press knows music/art, Conductor
knows lights) is preserved.

## Consequences

- Fixture goldens regenerated: Purple Rain → `rotate` (1595ms), Rumours → `rotate` (1562ms), Kind of
  Blue → `crossfade` (unchanged — its energy lands just under the threshold, so the mellow jazz
  record stays mellow), the three insufficient covers → `static` (unchanged). Records now feel
  distinct straight from their art.
- Pattern selection is no longer purely size-based. It remains **pure and deterministic** (energy is
  a function of the palette), so golden and caching guarantees hold.
- Thresholds (0.62 / 0.66) mean a borderline album can flip pattern type on a small palette nudge —
  an accepted cost; the golden suite catches it and the human `awaiting_review` step is the backstop.
- The user's per-album pattern override in Curator still wins — this only sets the _default_.
- `palette-press-spec` (§3, §5, §7), `roadie-spec`, `curator-spec`, `album-onboarding-workflow`, the
  Palette Press README, and `integration-contract` (audioFeatures semantics) were updated in the same
  change to match. The "Spotify audio-features deprecated → we don't auto-fetch" fact stays accurate
  everywhere; what changed is "so patterns are static/size-only" → "so energy comes from the palette."
- Live/real-time audio reactivity (a mic on the turntable, a per-track feedback loop) remains out of
  scope (runtime-overview §11) — this is still a pattern _pre-decided_ at onboarding, not a live loop.
