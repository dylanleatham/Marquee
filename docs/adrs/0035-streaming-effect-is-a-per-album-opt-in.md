# ADR 0035 — A streaming effect is a per-album opt-in, carried beside the derived pattern

Status: accepted · Date: 2026-07-27 · Narrows: [ADR 0030](0030-palette-from-album-feeling.md) (which
dropped the manual pattern override wholesale) · Completes:
[ADR 0024](0024-entertainment-dtls-transport.md) (which assumed this opt-in existed) · Amends:
[curator-spec](../specs/curator-spec.md) (new route), [curator-ui-ux](../specs/curator-ui-ux.md) (§5
Look tab), [hue-conductor-spec](../specs/hue-conductor-spec.md) (§9), [integration-contract](../specs/integration-contract.md)
(`palette-payload` gains an optional `streaming` block) · Addresses the streaming half of
[#133](https://github.com/dylanleatham/Marquee/issues/133)

## Context

The streaming effects — `aurora`, `shimmer`, `wave` — were **unreachable from the product loop**.

Everything else existed. [ADR 0023](0023-entertainment-streaming-effect-engine.md) built the effect
engine, [ADR 0024](0024-entertainment-dtls-transport.md) the DTLS transport, the HueStream v2
encoder, and the CLIP v2 handoff, verified on hardware. The contract carries the three types.
Conductor renders them correctly and falls back when there's no entertainment area. The only missing
link was the one that lets an album ask for one:

- **Palette Press never selects a streaming effect**, deliberately. Per ADR 0024, the _producer_
  can't know whether a given runtime has an entertainment area, so auto-selecting one would hand a
  CLIP-only setup the `rotate` fallback instead of the calmer default it would otherwise get.
- `asset.pattern` is written in exactly one place, from Palette Press's output.
- So every tagged scan resolved to a CLIP pattern, always.

ADR 0024 named the missing piece explicitly — "`aurora`/`shimmer`/`wave` reach an album via a Curator
per-album override" — but nothing built it. Then [ADR 0030](0030-palette-from-album-feeling.md)
recorded that "the manual override stays unbuilt" and formally dropped
`POST /api/albums/:curatorId/pattern`.

**ADR 0030 was deciding a different question.** Its subject is motion _energy_: whether a human should
hand-tune a pattern when the motion doesn't suit a record. Its answer — change where the colours come
from, because pattern is derived from palette energy ([ADR 0033](0033-palette-derived-motion-energy.md))
— is correct and stands. It never mentions streaming, entertainment areas, or any of the three
effects. Its blanket phrasing simply reached past the case it was deciding and took ADR 0024's opt-in
with it.

## Decision

**An album may opt into one streaming effect. The opt-in is a switch, not a pattern editor, and it is
stored beside the derived pattern rather than replacing it.**

1. **`asset.streamingEffect`** — `"aurora" | "shimmer" | "wave" | null`, a sibling of `pattern`.
   Absent/null is the default for every album and means the derived pattern plays.
2. **`PUT /api/albums/:curatorId/streaming-effect`** sets or clears it. `pattern` is never written by
   this route. Rejected while Roadie is processing, like a palette edit
   ([ADR 0025](0025-palette-edit-rejected-during-processing.md)).
3. **`PalettePayload` gains an optional `streaming: { effect }` block**, additive and backwards
   compatible. `pattern` continues to carry the derived CLIP pattern.
4. **Conductor plays `streaming.effect` when an entertainment area is configured, and otherwise plays
   `pattern`** — the album's own energy-aware motion, not a guess.
5. **No params.** The renderers' defaults are the opt-in's contract. `pattern.params` belong to the
   CLIP pattern standing by as the fallback; handing `intervalMs` to `aurora` would be nonsense.

### Why beside `pattern` and not in it

Setting `pattern.type = "aurora"` would have been a smaller change, and Conductor already handles it —
that path stays, for the Demo Room and manual `curl`. But it cannot express a fallback. When the
effect _is_ the pattern, a room with no entertainment area hits `clipFallback`, which picks
`rotate`/`pulse` from palette size and discards everything ADR 0033 derived for that album.

That would make opting in a silent downgrade for anyone without the hardware — the exact harm ADR 0024
cited as its reason not to auto-select. Carrying the opt-in alongside `pattern` makes the fallback the
album's own pattern, so opting in can only ever add.

## Consequences

- **The streaming stack becomes reachable.** Place a record on the stand and the room can run the
  Entertainment effects, which was the point of two ADRs' worth of work.
- **ADR 0030's reasoning is untouched for the case it decided.** Motion stays derived; there is still
  no way to hand-tune a params blob, and `POST /api/albums/:curatorId/pattern` stays dropped. What
  changes is that "no manual override of any kind" was broader than ADR 0030's argument supported.
- **Hardware-dependent behaviour is stated, not silent.** The Look tab says an entertainment area is
  needed and names the pattern that plays without one — per curator-ui-ux §10, pending and degraded
  states are owed an explanation.
- **The params half of [#133](https://github.com/dylanleatham/Marquee/issues/133) is still declined**,
  on ADR 0030's own argument. This ADR closes the streaming half only.
- **A new contract field to ignore.** `streaming` is optional; producers that omit it and consumers
  that ignore it behave exactly as before, per the contracts versioning rule.
