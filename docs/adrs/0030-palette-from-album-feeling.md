# ADR 0030 — A palette from the album's feeling, offered as a choice

Status: accepted · Date: 2026-07-26 · Extends: [ADR 0033](0033-palette-derived-motion-energy.md)
(energy from the palette), [ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md) (grounded
research pass) · Constrained by: [ADR 0027](0027-generation-is-invoked-not-pipelined.md) (Gemini is
invoked, never pipelined) · Supersedes: curator-spec's `POST /api/albums/:curatorId/pattern`

## Context

A palette is a pure function of the **cover image**. Palette Press extracts swatches; ADR 0033
derives motion energy from those same swatches, after Spotify's audio-features endpoint was
deprecated and automatic audio-feature fetching went out of scope.

So the room knows what the **sleeve** looks like and nothing about what the **record** sounds like.
Two albums with similar artwork produce similar rooms even if one is ambient and the other is
hardcore. A muted sleeve on a ferocious record gets a calm, slow crossfade. Usually the cover is
right — it is the object you just put on the stand — but when it isn't, there is currently nothing
to do about it short of picking hex codes by hand.

Meanwhile Gemini already performs a grounded research pass over each album (ADR 0009), and that
research is spent entirely on authoring prompts.

[Issue #105](https://github.com/dylanleatham/Marquee/issues/105) arrived here from a different
direction: `POST /api/albums/:curatorId/pattern` was documented and never built, and the right answer
was not "add a pattern editor." Hand-tuning a `pattern.params` blob is a poor substitute for the
derivation knowing more in the first place.

## Decision

**The cover is the default and always will be. A feeling-derived palette is an alternative you ask
for, per album, when the cover's colours aren't the ones you want.**

The Look workstation offers up to three palettes and you pick one:

1. **From the cover** — today's Palette Press extraction. Always present, free, deterministic, and
   what every album has until you say otherwise.
2. **From the feeling** — colours Gemini proposes from a grounded pass over how the record _sounds_
   and what it is about, with a one-line rationale.
3. **Blend** — the cover's dominant kept as primary, the feeling's colours grafted on as
   secondary/accent. The "informed by both" option, offered rather than imposed.

Five rules make that safe:

- **Nothing happens unless you ask.** No album gets a feeling pass on add, on Roadie's pipeline, or
  in a batch sweep. One button on Look, two Gemini text calls, ADR 0027's rule intact. No key
  configured → the section says so and the cover palette stands alone, which is today's behaviour
  unchanged.
- **Palette Press stays pure.** The feeling pass lives in Curator alongside the other Gemini callers
  and hands finished swatches through the same `sanitizePaletteEdit` validation a hand-edit goes
  through — hex normalised, `cie_xy` recomputed, gamut-clamped. Palette Press's golden suite keeps
  meaning what it means. An LLM inside a deterministic library would end that.
- **Choosing is recorded, and protects itself.** `palette.source` records `cover | feeling | blend |
hand`, and choosing anything other than the cover also sets `handEdited`. That is deliberate reuse
  rather than a second mechanism: `handEdited` already means "a human decided this palette, don't
  overwrite it," which is exactly true of a chosen feeling palette. Every existing protection —
  `regeneratePalette`'s 409, the library sweep's skip
  ([ADR 0029](0029-batch-work-runs-as-a-library-job.md)), "Reset to auto" — then works unchanged, with
  no new rule to keep in sync. `source` is provenance and display; `handEdited` is the guard.
- **Candidates are proposals until chosen.** The pass stores `paletteCandidates` on the asset and
  changes nothing else, so you can look at both against the sleeve, reload, and still be looking at
  them. Same shape as `cardArtCandidates` (ADR 0010) — generate a set, choose one, discard the rest.
- **Batch is unaffected by design.** A library sweep re-derives _cover_ palettes and skips everything
  chosen, so "regenerate all palettes after a Palette Press upgrade" never spends a Gemini call and
  never quietly reverts a decision.

**Pattern stays derived, and the manual override stays unbuilt.** ADR 0033's `paletteEnergy` runs on
whichever palette is in force, so choosing the feeling palette changes the motion too — which is the
point, and is why a pattern editor was never the answer to this problem. The documented
`POST /api/albums/:curatorId/pattern` route is formally dropped.

## Consequences

- **Non-determinism is contained to a candidate.** Asking twice can produce different colours. That
  is acceptable for something displayed next to a deterministic alternative and chosen by a human; it
  would not be acceptable as the default derivation, which is the main reason this is not a blend by
  default.
- **The stored palette stays a plain colour list.** Nothing downstream — Conductor, the runtime
  payload, the integration contract — learns about "feeling." The change is entirely in how colours
  are _arrived at_.
- **ADR 0033's energy threshold becomes reachable a new way.** A muted sleeve on a fierce record can
  cross 0.62 via the feeling palette and start rotating. Intended.
- **The library sweep reports a chosen palette as a hand-edit**, because that is what the flag says.
  Accurate about the protection, slightly coarse about the provenance; `source` carries the finer
  answer for anything that needs it. Splitting the two would buy a better word in one report at the
  cost of a second concept everywhere else.
- **The research pass gains a second consumer**, which strengthens the case for caching it per album
  rather than running it separately for prompts and colours. Not done here; noted.
- curator-spec §Palettes and §10 (Look workstation), palette-press-spec's "signals" framing, and the
  asset schema are updated in the same change.

## Alternatives considered

- **Blend by fixed weights, automatically.** What the issue first proposed. Rejected: it makes every
  palette non-deterministic and un-goldenable, spends a Gemini call per album at add time (straight
  against ADR 0027), and leaves no way to see what the cover alone would have produced. The blend
  survives as one of the offered options, which is where it belongs.
- **Feeling palette replaces the cover palette.** Rejected: the cover is the object on the stand.
  Losing "the lights match the sleeve" gives up the original product promise.
- **Feed the research into Palette Press as extraction hints.** Rejected: it puts a network call and a
  non-deterministic input inside a pure library, and Palette Press has no business knowing about
  Gemini.
