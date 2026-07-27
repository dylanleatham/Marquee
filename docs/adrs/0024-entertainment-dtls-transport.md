# ADR 0024 — Entertainment DTLS transport: node-dtls-client, HueStream v2, CLIP handoff

Status: accepted · Date: 2026-07-24 · Continues: [ADR 0023](0023-entertainment-streaming-effect-engine.md)
(which built the effect engine and deferred the transport to hardware)

## Context

ADR 0023 shipped the pure streaming effect engine (aurora/shimmer/wave + `StreamEngine` over a
`StreamTransport` port) and deferred the actual bridge transport, because it needs a DTLS library, the
bridge `clientkey`, a configured entertainment area, and a real bridge to handshake with — none
verifiable off-hardware. This ADR records the decisions made building that transport on the Pi.

## Decision

**DTLS library: `node-dtls-client@2`.** Pure-JS (no native build, so it installs anywhere), engines
`node >=22` matching ours, ships its own types, and supports the PSK handshake Hue requires. We do
_not_ use node-hue-api for Entertainment (its v4 line is CLIP v1; its entertainment support is thin).
The handshake wrapper (`createHueDtlsSocket`) is deliberately minimal — PSK identity = application
key, key = hex-decoded `clientkey`, UDP 2100 — because it's the one piece only hardware can verify.

**Protocol: hand-encode HueStream v2** (`encodeHueStreamFrame`, a pure function). The byte layout —
`"HueStream"` header, version 2.0, RGB color space, 36-byte entertainment-configuration id, then
per-channel `[channelId][R16][G16][B16]` — is the one transport detail we _can_ pin down and test
exhaustively off-hardware, so we own it rather than hide it in a library.

**CLIP v2 for what node-hue-api (v4/CLIP v1) can't do.** A tiny `Clip2Client` (over `node:https`,
LAN self-signed cert accepted per the runtime-overview §8 "prevent accidents" posture) lists
entertainment areas (id, name, per-channel positions) and PUTs `action: start/stop`. Everything else
still goes through the existing `BridgeAdapter`.

**`clientkey` captured at pairing.** The bridge only returns the DTLS PSK when the user is created, so
`BridgeAdapter.pair()` now stores it on the `BridgeRecord`. Records paired before this have no key —
re-pairing on the Pi is required (surfaced as a helpful 409 on the entertainment endpoints).

**Session lifecycle mirrors CLIP, with a snapshot↔stream handoff.** `StreamSession` snapshots the room
over CLIP, PUTs the area into streaming mode, opens DTLS, and runs the engine; `stop` halts the engine
(closing the socket), leaves streaming mode, and restores the snapshot — the same non-destructive
contract as CLIP playback, plus the same idle-timeout safety net. On a scan, if the album's pattern is
a streaming effect _and_ an area is configured, Conductor hands off CLIP → streaming; otherwise, or if
the handshake fails, it **falls back to a lively CLIP pattern** (rotate for a multi-colour palette,
pulse for a single colour) rather than a flat color — a
scan must always do something visible (runtime-overview §9).

**Streaming effects are opt-in, not auto-selected.** Palette Press still selects only CLIP patterns
(ADR 0033); `aurora`/`shimmer`/`wave` reach an album via a Curator per-album override. Rationale: the
_producer_ can't know whether a given runtime has an entertainment area, so auto-selecting a streaming
effect would hand CLIP-only setups the rotate _fallback_ instead of the calmer default they'd have
gotten. Opt-in keeps the automatic path honest; the contract still carries the types so an override
(and the Conductor) can use them.

## Consequences

- Streaming effects are now reachable from a real scan — ADR 0023's "not yet reachable" is resolved.
- New runtime dependency (`node-dtls-client`) on the Conductor. Pure-JS, so no build/deploy change.
- New settings key `entertainmentAreaId` (pushed from Curator like `listeningRoomId`) and a
  `GET /api/entertainment/areas` discovery endpoint.
- `/api/scan` and `/api/playback` share one routing helper, so streaming is reachable from a tagged
  scan _and_ from Curator's Demo Room / a manual `curl` — the helper also handles the CLIP↔streaming
  handoff in both directions (each holds the lights exclusively while active).
- The DTLS handshake and on-bulb rendering are verified **on hardware** (see `docs/runbook.md` §
  Entertainment streaming); everything else — encoder, CLIP v2 client, transport framing, session
  orchestration, scan routing/fallback — is unit-tested.
- Contract adds `aurora`/`shimmer`/`wave` to the pattern enum (additive; no version bump — old
  consumers ignore unknown types, and Conductor itself falls back when it can't stream).
- Specs reconciled: hue-conductor-spec §3/§4/§7/§9, integration-contract §1, README.
