# Hue Conductor

Headless Fastify service that drives Hue lights. Runs on the Pi 5 near the TV.
Spec: [../../docs/specs/hue-conductor-spec.md](../../docs/specs/hue-conductor-spec.md).

## Status — build step 5 (playback engine)

Implemented: bridge discovery + pairing CLI, room/light enumeration, a flat-color test
endpoint, and the **palette+pattern playback engine** (spec §9): `static`/`rotate`/`pulse`/
`crossfade`, per-light token-bucket rate limiting, room snapshot on start + restore on stop,
crossfade to a new palette on a mid-session swap, and a 90-minute idle safety-net. Driven via
`POST /api/playback`. Store-backed `POST /api/scan` (URI → palette lookup) waits on the
Curator→Conductor asset-store sync — the Curator Demo Room drives playback with explicit payloads
in the meantime (see [ADR 0007](../../docs/adrs/0007-demo-room-drives-conductor-via-curator-proxy.md)).

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

| Method  | Path                   | Purpose                                                                   |
| ------- | ---------------------- | ------------------------------------------------------------------------- |
| GET     | `/healthz`             | `{ ok, paired }` — no auth                                                |
| GET     | `/api/bridge/discover` | list bridges on the LAN                                                   |
| GET     | `/api/bridge/status`   | paired state + reachability                                               |
| GET     | `/api/rooms`           | rooms/zones with their light ids                                          |
| GET     | `/api/lights`          | flat list of lights                                                       |
| POST    | `/api/test/color`      | body `{ roomId, hex }` → set a flat color                                 |
| GET/PUT | `/api/settings`        | `{ listeningRoomId }`                                                     |
| POST    | `/api/playback`        | body `{ roomId?, palette }` → play a palette+pattern (snapshots the room) |
| POST    | `/api/playback/stop`   | body `{ roomId? }` → stop and restore the pre-session lighting            |

`roomId` defaults to the configured `listeningRoomId` on both playback routes.

## Smoke test (the playback-engine payoff)

```bash
SECRET=change-me-lan-only-secret
curl -s localhost:4737/api/rooms -H "X-Trigger-Secret: $SECRET"   # pick a roomId
# animate the room with a two-colour crossfade:
curl -s -X POST localhost:4737/api/playback \
  -H "X-Trigger-Secret: $SECRET" -H "content-type: application/json" \
  -d '{"roomId":"1","palette":{"version":1,"source":{"type":"test"},
       "palette":{"colors":[{"hex":"#4B0082","role":"primary"},{"hex":"#FFD700","role":"secondary"}]},
       "pattern":{"type":"crossfade","params":{"transitionMs":1500,"holdMs":3000}}}}'
# → the room fades between purple and gold. Then restore what was there before:
curl -s -X POST localhost:4737/api/playback/stop \
  -H "X-Trigger-Secret: $SECRET" -H "content-type: application/json" -d '{"roomId":"1"}'
```

## Notes

- Uses `node-hue-api` **v4** (stable) for CLIP flat color, and the **Entertainment API** for the
  streaming effects (aurora/shimmer/wave, 25 Hz) — engine in `src/stream/` (ADR 0023), DTLS
  transport via `node-dtls-client` + a HueStream v2 encoder + a tiny CLIP v2 client (ADR 0024).
  `pnpm preview:stream` renders the effects to an HTML page to watch without hardware; the DTLS
  handshake itself is verified on the Pi (see `docs/runbook.md`).
- Colors are sent as RGB and converted to the light's gamut by the library (spec §9,
  option 1). If deep purples land as blue on your bulbs, that's the gamut-clamping case to
  revisit with explicit xy conversion.
