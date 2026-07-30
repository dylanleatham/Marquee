# ADR 0039 — One motion picker: CLIP patterns become selectable, beside the derived one

Status: accepted · Date: 2026-07-29 · Supersedes: [ADR 0030](0030-palette-from-album-feeling.md)'s
"the manual override stays unbuilt" (its palette decision is untouched) · Generalises:
[ADR 0035](0035-streaming-effect-is-a-per-album-opt-in.md) (opt-in beside the derived pattern),
[ADR 0036](0036-streaming-effect-params-are-tunable.md) (tunable knobs from a shared spec) ·
Amends: [curator-spec](../specs/curator-spec.md) (route renamed), [curator-ui-ux](../specs/curator-ui-ux.md)
(§5 Look tab), [hue-conductor-spec](../specs/hue-conductor-spec.md) (§9),
[integration-contract](../specs/integration-contract.md) · Closes the remaining half of
[#133](https://github.com/dylanleatham/Marquee/issues/133)

## Context

The Look tab has a "Streaming effect" picker with four options — Off, Aurora, Shimmer, Wave — and,
since ADR 0036, sliders for the chosen effect. The four CLIP patterns the room actually plays most of
the time (`static`, `rotate`, `pulse`, `crossfade`) are not in that list, because ADR 0030 dropped the
manual pattern override and ADR 0036 re-affirmed "CLIP pattern params stay derived and untunable."

The result reads as an accident rather than a decision. The picker is titled for the transport
(Entertainment streaming) rather than for what a human is choosing (how the lights move), so half the
answers are missing from a list that looks complete, and the half that is present is the half most
rooms can't play — the streaming effects need an entertainment area, the CLIP patterns need nothing.

**ADR 0030's argument is about derivation, and it holds — but it decided a narrower question than its
phrasing.** Its case against a pattern editor is: hand-tuning a params blob is a poor substitute for
the derivation knowing more in the first place, and once you allow an override you owe a `handEdited`
flag, a reset affordance, a library-sweep skip, and an answer to "the palette changed — is my
override still valid?" That reasoning was written when an override meant _overwriting_ `pattern`.

ADR 0035 then built the thing that dissolves it. Its "beside `pattern`, not in it" rule means the
derived value is never written over, and every consequence ADR 0030 feared drops out:

- there is nothing to protect, so no `handEdited` and no sweep interaction — a sweep re-derives
  `pattern`, which the override doesn't touch;
- "reset to auto" is deleting one field, not restoring a value from somewhere;
- the staleness question has an answer by construction — regenerate the palette, `pattern` re-derives
  underneath, and the override still means what it said.

What's left of ADR 0030's case is the good part: **derivation is the default and stays the default.**
That is a statement about what happens when you do nothing, and it survives an override that only
ever exists because a human deliberately chose it.

The judgement an override serves is one the derivation structurally cannot make. `paletteEnergy`
reads the sleeve; it cannot see that this room's four bulbs are spread down a long hallway where a
rotate reads as a chase and a crossfade reads as breathing. ADR 0036 accepted exactly this argument
for `aurora.speed` ("a default that reads well in a small room may crawl in a large one") and then
declined it for `crossfade.holdMs`, which is the same argument about the same room.

## Decision

**One picker, one field. An album may override its motion with any of the seven pattern types, CLIP
or streaming, and tune that choice's own knobs. Absent — the default for every album — means the
derived pattern plays.**

1. **`asset.patternOverride`** — `"static" | "rotate" | "pulse" | "crossfade" | "aurora" | "shimmer" |
"wave" | null`, a sibling of `pattern`, which stays exactly as Palette Press derived it.
   `asset.patternOverrideParams` carries the tuning. These generalise ADR 0035's `streamingEffect` /
   `streamingParams`, which they replace; a stored asset carrying the old names is read as the new
   ones (see "Migration").
2. **`PUT /api/albums/:curatorId/pattern-override`** takes `{ type, params? }` and replaces
   `PUT /api/albums/:curatorId/streaming-effect`. `pattern` is never written by this route. Rejected
   while Roadie is processing, as a palette edit is ([ADR 0025](0025-palette-edit-rejected-during-processing.md)).
3. **`PATTERN_PARAM_SPECS` in `@marquee/contracts`** grows a CLIP half — label, range, step, default,
   and a plain-language hint per knob — and remains the single source the server validates against and
   the UI draws sliders from. `STREAM_PARAM_SPECS` and `validateStreamParams` are subsumed by it and
   by `validatePatternParams`.
4. **How the override reaches the payload depends on which half it names**, and this asymmetry is the
   whole reason the two halves can share one picker:
   - a **streaming** override rides in the optional `streaming` block and leaves `pattern` alone, so a
     room with no entertainment area falls back to the album's own derived motion (ADR 0035 unchanged);
   - a **CLIP** override replaces `pattern` in the payload — resolved to complete params, since the
     contract requires them — because CLIP is what every room can play. There is nothing to fall back
     to and nothing lost by not falling back.
     The asset is untouched either way; resolution happens in `buildPalettePayload`.
5. **A value equal to the spec default is not stored**, extending ADR 0036's rule to all seven types.
   The spec default is _the_ default: choosing `rotate` starts from the spec's interval rather than
   inheriting whatever `intervalMs` the derived pattern happened to carry. One rule, and an override
   means the same thing regardless of what it displaced.

### What stays derived

`asset.pattern` — always, and it remains what plays for every album that hasn't been overridden,
which is expected to stay the overwhelming majority. Palette Press keeps selecting it from palette
energy ([ADR 0033](0033-palette-derived-motion-energy.md)); nothing here feeds back into the
derivation, and choosing a feeling palette still changes the motion exactly as ADR 0030 intended.

### Migration

`streamingEffect` / `streamingParams` are read as `patternOverride` / `patternOverrideParams` when the
new fields are absent, normalised on read in `AssetStore.read` and in `buildPalettePayload` (Conductor
reads the synced store directly — [ADR 0019](0019-conductor-scan-reads-asset-store.md) — so both
readers need it). An asset is rewritten to the new names the next time it is saved. The old field
names are legacy-read only: nothing writes them.

## Consequences

- **The picker matches the question.** "How should this record move the lights" has seven answers plus
  auto, and all eight are in one list. Naming it for the transport was the actual defect.
- **CLIP overrides work without an entertainment area**, so this is the first motion control most
  rooms can use at all. The streaming half stays hardware-gated and still says so.
- **ADR 0036's drift risk widens slightly.** Its `STREAM_PARAM_SPECS` ↔ renderer-defaults test still
  guards the streaming half. The CLIP defaults have no renderer constant to mirror — the engine reads
  whatever the payload carries — so their guard is the payload schema instead: a test asserts every
  CLIP spec's min/default/max resolve to a payload the `palette-payload` schema accepts. Without it a
  slider could offer `holdMs: 0.5` and produce an asset that Conductor's own contract rejects.
- **`rotate.direction` is not exposed.** The knob system is numeric, and one enum control is not worth
  a second param kind today; a CLIP `rotate` override resolves to `forward`, as every derived rotate
  already does. Noted as the obvious next knob rather than silently omitted.
- **Two more things a human sets.** ADR 0036 counted three levers (palette source, streaming opt-in,
  streaming params); it is now three, because the second and third generalised rather than multiplied.
  Only the palette source touches anything derived — the line ADR 0036 drew, now drawn once instead of
  per-transport.
- **A route rename is a breaking change to a documented endpoint.** `PUT /streaming-effect` returns
  404 rather than being aliased. The only caller is Curator's own UI, shipped from the same repo, and a
  404 is louder than an alias that quietly ignores half the new options.
