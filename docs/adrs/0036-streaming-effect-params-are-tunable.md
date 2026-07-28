# ADR 0036 — Streaming-effect params are tunable; CLIP pattern params stay derived

Status: accepted · Date: 2026-07-27 · Extends:
[ADR 0035](0035-streaming-effect-is-a-per-album-opt-in.md) (which shipped the opt-in with no params) ·
Does **not** disturb [ADR 0030](0030-palette-from-album-feeling.md) (CLIP pattern stays derived) ·
Amends: [curator-spec](../specs/curator-spec.md), [curator-ui-ux](../specs/curator-ui-ux.md) (§5),
[hue-conductor-spec](../specs/hue-conductor-spec.md) (§9), [integration-contract](../specs/integration-contract.md) ·
Addresses the remaining half of [#133](https://github.com/dylanleatham/Marquee/issues/133) for
streaming only

## Context

ADR 0035 shipped the per-album streaming opt-in as a switch with no tuning, on the stated grounds
that "the renderers' defaults are the opt-in's contract." That was a scope decision, and it was
presented as though it followed from ADR 0030. It doesn't.

**ADR 0030's argument does not reach these params.** Its force comes entirely from _pattern is
derived_: don't let a human hand-override a value the system computes from palette energy, because
then you need `handEdited`, a reset affordance, a library sweep that skips overridden albums, and an
answer to "the palette changed — is my override still valid?" That reasoning is sound, and it is why
CLIP pattern params stay underived and untunable.

The streaming effects' params are a different thing entirely:

- Palette Press never computes them. It selects only CLIP patterns ([ADR 0024](0024-entertainment-dtls-transport.md)).
- ADR 0035 sends `{}` and the renderers apply their own defaults.
- So there is **nothing derived to conflict with** — no staleness question, no `handEdited`, no sweep
  interaction. Changing the palette cannot invalidate `aurora.speed`.

Seven optional numbers across three effects (`aurora`: speed/scale/brightness; `shimmer`:
speed/intensity; `wave`: speed/angleDeg), and ADR 0030 has nothing to say about any of them.

There is also a place to judge the result. Bench preview never touches hardware
([ADR 0028](0028-preview-bench-and-room-modes.md)), but **Room rehearsal does**, behind the arm
switch — so "arm the room, nudge, watch" is a real loop, not a blind one.

## Decision

**The chosen streaming effect's own params are tunable per album. CLIP pattern params remain derived
and untunable.**

1. **`asset.streamingParams`** — a sibling of `streamingEffect`. Only knobs moved off their default
   are stored; switching effects clears it, since `aurora.scale` means nothing to `wave`.
2. **`STREAM_PARAM_SPECS` in `@marquee/contracts`** declares each knob's label, range, step, default,
   and a plain-language hint — **once**. The server validates against it and the UI draws sliders
   from it. Two copies of a range is a bug waiting to happen: a slider offering a value the API
   rejects is worse than no slider.
3. **`PUT /api/albums/:curatorId/streaming-effect` takes an optional `params`.** Omitted leaves
   existing tuning alone; `{}` resets to defaults; an out-of-range or foreign knob is a `400`.
4. **The payload's `streaming` block gains an optional `params`**, additive as before.
5. **A value equal to the renderer's default is not stored.** "Untouched" and "explicitly set to the
   default" must not become two states that look identical today and diverge if a default ever moves.

### What stays declined

Hand-tuning `intervalMs`, `holdMs`, `periodMs` and friends on the derived CLIP pattern. ADR 0030's
argument applies there with full force, and nothing in this ADR weakens it. If that ever needs
revisiting, it needs an ADR that supersedes 0030 rather than another one that narrows it.

## Consequences

- **The effects become adjustable to a real room.** A default `aurora.speed` that reads well in a
  small room may crawl in a large one; that is exactly the kind of thing only the owner can judge.
- **Bounds are usable ranges, not renderer limits.** `aurora.speed` accepts any positive number;
  past ~0.5 it stops reading as an aurora. The sliders offer the range worth having.
- **One more thing a human sets that affects motion.** ADR 0030's "one lever" is now three — palette
  source, streaming opt-in, streaming params. Only the first touches anything derived, which is the
  line this ADR draws and the previous two blurred.
- **A drift risk between the specs and the renderers.** `STREAM_PARAM_SPECS` mirrors defaults that
  live in `hue-conductor/src/stream/renderers.ts`. A test asserts they match; if a renderer default
  moves and the spec doesn't, the UI shows the wrong "untouched" position for every album.
