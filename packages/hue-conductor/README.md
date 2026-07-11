# Hue Conductor

Headless Fastify service that drives Hue lights. Runs on the Pi 5 near the TV.
Spec: [../../docs/specs/hue-conductor-spec.md](../../docs/specs/hue-conductor-spec.md).

## Status — build step 1 (bridge + read + flat color)

Implemented: bridge discovery + pairing CLI, room/light enumeration, and a flat-color
test endpoint. The palette playback engine (patterns, rate limiting, snapshot/restore,
scan handling) comes in later steps.

## Setup

1. From the repo root: `pnpm install`.
2. Pair the bridge (on the machine/LAN with the Hue bridge):
   ```bash
   pnpm --filter @marquee/hue-conductor pair
   ```
   Pick your bridge, press its round link button when prompted. The application key is
   saved to `data/conductor.json` (gitignored).
3. Set the shared secret so the API is authed. Either export `TRIGGER_SHARED_SECRET`, or
   copy `config.example.toml` → `config.toml` and set `[auth].shared_secret`. (With no
   secret set, the service boots with auth **disabled** and warns — fine for a quick local
   try, not for the Pi.)

## Run

```bash
pnpm --filter @marquee/hue-conductor dev     # tsx watch, port 4737
```

## Endpoints (all require `X-Trigger-Secret` except `/healthz`)

| Method  | Path                   | Purpose                                   |
| ------- | ---------------------- | ----------------------------------------- |
| GET     | `/healthz`             | `{ ok, paired }` — no auth                |
| GET     | `/api/bridge/discover` | list bridges on the LAN                   |
| GET     | `/api/bridge/status`   | paired state + reachability               |
| GET     | `/api/rooms`           | rooms/zones with their light ids          |
| GET     | `/api/lights`          | flat list of lights                       |
| POST    | `/api/test/color`      | body `{ roomId, hex }` → set a flat color |
| GET/PUT | `/api/settings`        | `{ listeningRoomId }`                     |

## Smoke test (the build-step-1 payoff)

```bash
SECRET=change-me-lan-only-secret
curl -s localhost:4737/api/rooms -H "X-Trigger-Secret: $SECRET"
# pick a roomId from the output, then:
curl -s -X POST localhost:4737/api/test/color \
  -H "X-Trigger-Secret: $SECRET" -H "content-type: application/json" \
  -d '{"roomId":"1","hex":"#4B0082"}'
# → your lights turn purple.
```

## Notes

- Uses `node-hue-api` **v4** (stable). The spec suggests v5 for the Entertainment API
  (25 Hz streaming), which is out of scope until the streaming visualizer work — the thin
  Bridge Adapter (`src/bridge/adapter.ts`) is the seam to swap it then.
- Colors are sent as RGB and converted to the light's gamut by the library (spec §9,
  option 1). If deep purples land as blue on your bulbs, that's the gamut-clamping case to
  revisit with explicit xy conversion.
