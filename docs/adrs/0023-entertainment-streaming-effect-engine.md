# ADR 0023 — Entertainment streaming: build the effect engine now, the DTLS transport on hardware

Status: accepted · Date: 2026-07-23 · Amends: hue-conductor-spec §3 (Entertainment "out of scope,
designed-around" → in progress) and §9; relates to [ADR 0002](0002-hue-conductor-v4-and-dev-auth.md)
(the thin `BridgeAdapter` seam named for exactly this)

## Context

The CLIP v2 path Conductor uses today is capped at ~10 commands/sec/light with the _bridge_ doing the
fades. That's fine for `static`/`rotate`/`pulse`/`crossfade`, but it can't do continuous motion — the
"wow" effects (a flowing aurora, a candlelight shimmer, a colour wave that sweeps across the room)
need ~25 Hz updates to _all_ lights at once. That's what the Hue **Entertainment API** provides: a
DTLS/UDP stream where _we_ interpolate every frame. Both the spec (§3, §9) and ADR 0002 explicitly
kept the architecture "designed-around" this, with the `BridgeAdapter`/transport as the seam.

Constraint that shapes this decision: the Entertainment transport is DTLS/UDP and needs (a) a DTLS
library, (b) the bridge's `clientkey` PSK (captured at pairing — Conductor doesn't store it today),
(c) a configured _entertainment area_ (a Hue concept distinct from a Room, carrying per-light x/y/z
positions), and (d) a real bridge to handshake with. None of that is verifiable off-hardware, and the
dev sandbox can't install the DTLS dep or reach a bridge. Building the whole thing blind would be
untested code pretending to be done.

## Decision

Split the work by what can be verified, and build the verifiable, valuable half now.

**This change (PR-A) — the effect engine, pure and testable, no bridge:**

- A `stream/` module in Conductor with pure, deterministic building blocks: `valueNoise2D`
  (dependency-free 2D value noise), `sampleGradient` (cyclic palette gradient), and three
  `StreamRenderer`s — **aurora** (noise flow-field colour drift), **shimmer** (held palette + per-light
  brightness twinkle), **wave** (palette sweeps across real light _positions_). A renderer is
  `frame(tMs) → per-light RGB`; same input, same output.
- A `StreamEngine` that samples a renderer at a fixed, fps-capped rate (default 25) and pushes frames
  to a `StreamTransport` **port**. Timers and the clock are injected, exactly like the CLIP
  `PlaybackEngine`, so cadence is stepped deterministically in tests. `FakeStreamTransport` records
  frames for tests and the preview.
- A `preview:stream` script that runs the real renderers over a sample room and writes a
  self-contained HTML page animating the frames as glowing orbs — so the effects are verifiable _by
  eye_ with no hardware.

**Deferred (PR-B) — the transport, on the Pi:** the real `DtlsStreamTransport` implementing the port,
`clientkey` capture in pairing + storage, entertainment-area discovery/config (source of the light
positions), wiring streaming into `/api/scan` (arming the same idle-timeout safety net), and adding
the streaming pattern types to the shared `PalettePayload` contract + Palette Press selection.

## Consequences

- The fun logic — the part that decides how these effects _look_ — ships now with full unit coverage
  and an at-a-glance preview, de-risking the hard transport work.
- **The streaming effects are deliberately not yet reachable from a scan.** They're exercised by tests
  and the preview, not the HTTP path. This is a foundation increment, not dead code — PR-B wires it.
  Framing it here keeps that honest (the streaming pattern types are intentionally _not_ added to the
  `PalettePayload` enum yet, so no shipped consumer advertises an effect it can't render).
- The `StreamTransport` port is the single seam PR-B implements; the renderers/engine won't change
  when the DTLS transport lands.
- Positions are modelled as `StreamLight {x,y}` now; PR-B populates them from the entertainment area.
- No new runtime dependency is added in this change (the DTLS lib comes with PR-B, on a machine that
  can install and verify it).
- Live/real-time audio reactivity (a mic, a per-track feedback loop) is still out of scope
  (runtime-overview §11). These effects are pre-decided per album, streamed — not audio-reactive.
