# ADR 0002 — Hue Conductor: node-hue-api v4 and a dev-only auth fallback

Status: accepted · Date: 2026-07-10

## Context

Building Conductor step 1 surfaced two places where the implementation intentionally
differs from the letter of `hue-conductor-spec.md` / `runtime-overview.md`. Recording them
so the divergence is a decision, not drift (the Spec Adherence reviewer flagged both).

## Decision

**1. node-hue-api v4, not v5.** The spec's tech-stack and architecture diagram describe
node-hue-api v5 speaking CLIP v2, chosen for its Entertainment API (25 Hz DTLS streaming).
v5 is still beta (`5.0.0-beta.16`); the stable line is v4.0.11, which uses the bridge's
legacy local API. Conductor step 1 needs only discovery, pairing, room/light enumeration,
and flat color — all of which v4 does reliably. Entertainment streaming is explicitly out
of scope until the streaming-visualizer work. We use v4 now and will migrate to v5 when
Entertainment is actually built and v5 is stable. The thin `BridgeAdapter` /`HueDriver`
port (`src/bridge/adapter.ts`) is the seam that keeps that migration contained.

**2. Auth is disabled when no shared secret is configured.** The cross-cutting auth rule
(runtime-overview §8) is that the `X-Trigger-Secret` is required on all service-to-service
calls. Conductor enforces this whenever a secret is set (config `[auth].shared_secret` or
`$TRIGGER_SHARED_SECRET`). With **no** secret configured it boots with auth disabled and
logs a warning — a deliberate dev-ergonomics affordance so you can `curl` on your
workstation without ceremony. On the Pi, a secret is always configured, so the rule holds
in the deployment that matters.

## Consequences

- Colors are sent as RGB and gamut-clamped by node-hue-api v4 (spec §9 option 1). Deep
  purples landing as blue would be the signal to add explicit xy conversion.
- A future v5 migration touches only `nodeHueDriver`; the adapter's callers and tests
  (which use the injected `HueDriver`) are unaffected.
- The unauthenticated-when-unconfigured path must never ship as the Pi's running state.
  The boot warning is the guard; the Pi's `config.toml` sets the secret.
