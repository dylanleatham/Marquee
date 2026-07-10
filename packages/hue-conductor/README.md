# Hue Conductor

Headless service (Fastify) that drives Hue lights from palette+pattern payloads.
Runs on the Pi 5. Spec: [../../docs/specs/hue-conductor-spec.md](../../docs/specs/hue-conductor-spec.md).

**First milestone (build order step 1):** bridge pairing via `pnpm run pair`, then `/api/rooms`,
then `POST /api/test/color` → your real lights change. This is the highest-value first proof.
