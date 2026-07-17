# ADR 0007 — The Demo Room drives Conductor through a Curator proxy, via explicit playback payloads

Status: accepted · Date: 2026-07-17 · Relates to: [runtime-overview §6](../specs/runtime-overview.md) (the "preview, no hardware" onboarding step), [hue-conductor-spec §8/§9](../specs/hue-conductor-spec.md), [curator-spec §10](../specs/curator-spec.md)

## Context

Before the Raspberry Pis exist, we want to _see and feel_ the runtime experience from the
workstation: the visualizer video playing fullscreen and the **real Hue lights** reacting as a sleeve
is "placed" and "lifted." The Hue bridge is already paired, and Conductor is a plain Node service that
reaches the bridge over the LAN, so it can run on the workstation — no Pi needed for lighting.

Two design questions fell out of building this "Demo Room" screen in Curator's UI:

1. **How does the browser reach Conductor?** Conductor's API is authenticated with the shared
   `X-Trigger-Secret` and runs on a different origin/port (4737) than Curator (4739). Calling it
   directly from the browser would put the secret in client code and require CORS on Conductor.
2. **How does Conductor learn _what_ to play?** The spec has two entry points: `POST /api/scan`
   (Conductor resolves a `uri` to a palette+pattern by reading its local copy of the album-assets
   store) and `POST /api/playback` (the caller hands Conductor an explicit palette payload). The
   scan path assumes the Curator→Conductor asset-store sync, which isn't built yet.

## Decision

**1. Curator proxies Conductor under a `/api/demo/*` namespace; the browser only talks to Curator.**
Curator holds the shared secret server-side and forwards to Conductor with the `X-Trigger-Secret`
header. The Demo Room UI makes same-origin calls to `/api/demo/{play,stop,rooms,room,status}`. This
mirrors the precedent in [ADR 0004](0004-curator-agent-endpoint-namespace.md) (a dedicated Curator
endpoint namespace) and keeps the auth boundary and CORS story simple: exactly one authenticated
hop, server-to-server.

**2. The Demo Room drives Conductor via `POST /api/playback` with an explicit payload, not
`/api/scan`.** Curator already has each album's palette + pattern in its asset store, so on "place
sleeve" it builds the shared `PalettePayload` (`@marquee/contracts`) and hands it to Conductor
directly. Conductor's playback engine snapshots the room, animates the pattern, crossfades to a new
palette on a swap, and restores the snapshot on stop — all exercised without Conductor needing to
read Curator's store. The store-backed `/api/scan` path (and the rsync sync it needs) is deferred to
when the runtime Pi is actually in play.

**Conductor being unreachable is a first-class, non-error state.** `/api/demo/status` reports
`reachable: false` (HTTP 200) rather than failing, and the Demo Room still plays the (local) video —
the lights just don't respond. The experience degrades to "video only" instead of breaking.

## Consequences

- **The shared secret never reaches the browser**, and Conductor needs no CORS config. The cost is a
  thin proxy layer in Curator (`/api/demo/*`) that mostly forwards requests.
- **No Curator→Conductor asset-store sync is required for the demo.** The tradeoff: the demo doesn't
  exercise the real `/api/scan` resolution path. That path lands with the Pi/sync work; the playback
  engine underneath it is identical, so this isn't throwaway.
- **The Demo Room doubles as the reference implementation for Backdrop's real SPA** (fullscreen video
  with idle→play→crossfade transitions) and as the first real consumer of Conductor's playback
  engine — so it validates both spec §9 (Conductor) and the Backdrop transition model early.
- If we later want the browser to hit Conductor directly (e.g. lower latency for a wall-panel remote),
  the `/api/demo/*` shapes are small and already define the contract to move.
