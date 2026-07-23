# ADR 0023 — Meta prompts must exclude real/identifiable people (Gemini person-safety)

Status: accepted · Date: 2026-07-23 · Amends: [roadie-spec §7](../specs/roadie-spec.md) ("Prompt
drafting") · Builds on: [ADR 0009](0009-llm-authored-grounded-prompts-via-gemini.md) (grounded LLM
prompts), [ADR 0021](0021-card-art-five-option-prompt-strategy.md) (card-art five-option strategy),
[ADR 0022](0022-video-prompt-parity-narrative-and-per-prompt.md) (video prompt parity)

## Context

The card-art and video meta prompts (ADRs 0021/0022) author image/video prompts that get run against
the Gemini stack (Nano Banana image, Omni video) — in-app and by hand via Google Flow. **Gemini's
person-safety filter rejects prompts that feature real, prominent, or identifiable people.** Several
of the meta prompts' fixed options were steering straight into that:

- **Cover Reimagining / Cover in Motion** adapts the front cover — and a large share of album covers
  are a portrait of the recording artist, so "adapt/animate the cover" implicitly asks for a famous
  face.
- **Visual Artist Provenance** said "explicitly names and style-matches the original visual artist" —
  authoring prompts that name a real person.
- **Live Performance Era** depicted performers on stage (only a weak "no clear faces" caveat).
- **Signature Motif** could resolve to the artist.
- The **abstract** metaprompt had an "unless explicitly iconic to the album" loophole that invited
  literal performers.

The result: drafted prompts that fail generation, and a poor manual experience in Flow.

## Decision

**Every metaprompt carries an explicit "no real, identifiable, or famous people" guardrail, the
drafter reinforces it in the output override, and the people-leaning options are reshaped toward
environment / objects / silhouettes / technique.** No authored prompt may request the recording
artist (or any real figure) or a recognizable face.

1. **Negative constraint in all four metaprompts** (`docs/prompts/*.md`, bundled at
   `gemini/metaprompts.ts`, drift-guard tested): a bullet forbidding depiction, naming, or likeness of
   the recording artist, band members, or any real public figure — and, when the source cover centers
   on a person, directing the model to build from the surrounding environment, wardrobe, objects,
   textures, and atmosphere, with any human presence rendered as an anonymized silhouette / out-of-focus
   form. The abstract metaprompt's "unless explicitly iconic" loophole is removed.

2. **Options reshaped.** _Cover_ options add portrait-handling guidance (animate/adapt around the
   person, keep any face anonymized). _Visual Artist Provenance_ now **identifies** the artist to
   borrow their **techniques** (film stock, lighting, lenses, palette, composition), described as
   craft — "borrow the technique, not the face" — instead of naming a person as a subject. _Live
   Performance Era_ is built from stage architecture, light rigs, haze, crowd silhouettes, and
   instruments, with no identifiable performers. _Signature Motif_ is explicitly a physical
   object/set/place, not a person.

3. **Drafter reinforcement.** The grounded drafter's OUTPUT OVERRIDE (`gemini/draft.ts`) appends a
   hard, non-negotiable safety line to every drafting call regardless of type/style, so a metaprompt
   drift or an off-script model still can't author a person-featuring prompt.

## Consequences

- Fewer downstream rejections; the in-app "Generate art/clip" and the copy-to-Flow path both produce
  usable prompts more reliably.
- Some fidelity is traded for safety: an album whose whole identity is the artist's face will lean on
  environment/era/technique rather than the portrait. Acceptable — a rejected prompt yields nothing.
- **This is a content/guardrail refinement, not an architecture change.** The five fixed options,
  routes, generation flows, and UI are unchanged.
- **Guarded by tests:** a content assertion that each metaprompt contains the no-people guardrail, and
  a drafter test asserting the safety line reaches the drafting user turn — so the guardrail can't be
  silently dropped (CLAUDE.md "close the blind spot").
- **Note (not eliminated for portraits):** the video path passes the album cover to Omni as the image
  reference, so a pure-portrait cover still carries the face into the reference. The guardrail steers
  the _prompt_ away from the person and reduces rejections, but doesn't strip the reference image.
