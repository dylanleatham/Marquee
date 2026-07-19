# ADR 0012 — Artifact generation is opt-in; prompts are the default

Status: accepted · Date: 2026-07-18 · Amends: [ADR 0010](0010-auto-card-art-generation-candidate-set.md), [ADR 0011](0011-auto-generate-visualizer-clips.md), [curator-spec §Videos/§Card art](../specs/curator-spec.md)

## Context

ADRs 0010 (card art) and 0011 (video) added API artifact generation. In practice the **cost is very
lopsided**: prompt drafting is ~free, card art is ~$0.20 per 5-image click, but **video is metered
Veo** — roughly $6–$30 per "Generate clips" click (5 clips × ~8s, depending on tier). The maintainer
would rather generate video through **Google Flow** (a flat monthly credit allotment, much cheaper
for this use) by copying the drafted prompt, and only occasionally use the API.

As shipped, the generate buttons appeared whenever a Gemini key was configured, which makes an
expensive Veo run one stray click away — a real footgun given the price.

## Decision

**Artifact generation is opt-in per artifact, default off. With a key configured but generation off
(the default), Curator only _drafts_ the prompts — you copy them into your own tools (Nano Banana,
Google Flow, etc.). The grounded prompt drafting and "Regenerate with AI" are never gated — they're
the cheap, core value.**

- Two independent flags, both default `false`: `generateCardArt` and `generateVideo` (kept separate
  because card art is cheap and video is not — no reason to force them together).
- Resolved in `config.gemini` via the usual chain: `config.toml [gemini] generate_card_art /
generate_video` → `GEMINI_GENERATE_CARD_ART` / `GEMINI_GENERATE_VIDEO` env → `settings.json`. The
  in-app Settings screen has a checkbox for each (toggling persists without re-entering the key).
- The generate **actions** 400 when their flag is off (`generateCardArtSet`, `generateVideoSet`); the
  **UI** hides the corresponding "Generate…" button (`AlbumDetail` reads the flags and passes a
  `canGenerate` prop to `CardArtSection`/`VideoSection`). Existing generated candidates/clips remain
  usable if a flag is later turned off.
- Like the key, the flags are read at boot, so a change takes effect on restart.

## Consequences

- **Default experience is prompts-only** — the cheap path, with the expensive Veo call behind a
  deliberate opt-in. No more one-click surprise Veo bills.
- The video model slug + variant count remain overridable (`GeminiClient.videoModel`,
  `PROMPT_VARIANTS`), so someone who does turn video on can point at a cheaper Veo tier.
- ADRs 0010/0011 still describe the generation mechanics; they now additionally require the opt-in
  flag (this ADR) before the action runs.
