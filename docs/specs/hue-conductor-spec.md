# Hue Conductor — Technical Spec

_Drives the Hue lights in response to scan events; owns the palette-to-hardware translation._

## 1. Purpose

A local service that receives a **palette + pattern** payload over HTTP and drives Philips Hue lights accordingly. This is the "output side" of the record-triggered lighting system: it knows how to talk to Hue, but knows nothing about music. Any upstream system (the Palette Press generator, a manual UI, a future record-recognition service) can drive it via the same JSON contract.

## 2. Success criteria

**Can you `curl` a palette payload at this service and watch the lights in a chosen room change to match, hold, cycle, or pulse?**

If yes, the concept is viable and every future upstream (album analyzer, live audio visualizer, autonomous agent) is a matter of producing valid payloads. Everything in this spec is in service of proving that one thing.

## 3. Scope

### In scope

- Local Hue Bridge pairing via a one-time CLI script
- Credential storage on disk
- Enumerating rooms/zones/lights
- Applying a static palette (one color per light in a room)
- Playing a timed pattern (rotate, pulse, crossfade) for a duration
- HTTP API for external systems (Curator, Stylus) to submit palettes and query state

### Out of scope (but designed around)

- ~~Entertainment API streaming~~ — **now in scope and wired** (effect engine [ADR 0023](../adrs/0023-entertainment-streaming-effect-engine.md); DTLS transport [ADR 0024](../adrs/0024-entertainment-dtls-transport.md)). Aurora/shimmer/wave stream to a configured entertainment area over DTLS at 25 Hz; a scan hands off CLIP → streaming and falls back to a CLIP pattern when no area is configured (§9 "Streaming patterns")
- Multi-bridge support
- Cloud/remote control via Hue Remote API
- Persistent scheduling, scenes, or automations
- Record identification / audio input
- Its own UI — Conductor is headless. Any admin operations happen via Curator on your workstation (which calls Conductor's HTTP endpoints) or via the pairing CLI script.

## 4. Recommended tech stack

Optimized for Windows dev, Node ecosystem you already know, and Claude Code compatibility.

- **Runtime**: Node.js 22, TypeScript
- **Server framework**: Fastify (lower ceremony than Express, great TS support, built-in JSON schema validation which we'll use for the integration contract)
- **Hue library**: `node-hue-api` (v4) for discovery, pairing, and CLIP v1 flat color. Streaming visualizers via Entertainment (25 Hz per light) are **implemented** ([ADR 0023](../adrs/0023-entertainment-streaming-effect-engine.md) + [ADR 0024](../adrs/0024-entertainment-dtls-transport.md)) with a dedicated DTLS client (`node-dtls-client`) and a hand-written HueStream v2 encoder + tiny CLIP v2 client — not via node-hue-api, whose v4 line doesn't cover CLIP v2 entertainment. The `StreamTransport` port keeps that stack off the effect renderers.

  > **Implemented on v4, not v5 (2026-07-11; see [ADR 0002](../adrs/0002-hue-conductor-v4-and-dev-auth.md)).** v5 is still beta; the stable v4.0.x line covers everything step 1 needs (discovery, pairing, rooms/lights, flat color). Entertainment streaming is out of scope until the streaming-visualizer work, and the thin `BridgeAdapter`/`HueDriver` port is the seam to migrate to v5 (and CLIP v2 proper) then. Also per ADR 0002: the `X-Trigger-Secret` check is enforced whenever a shared secret is configured, but the service boots with auth **disabled + a warning** when none is set, as a dev-only affordance (the Pi always sets one).

- **Storage**: SQLite via `better-sqlite3` for bridge credentials, saved palettes, and playback history. In-memory Map is fine if you want to skip SQLite for the very first pass.
- **Process management**: systemd unit on the runtime Pi. Auto-restart on failure, boot with the system.

Rationale for local-first (running on the runtime Pi, not on a cloud host): Hue's Remote API adds OAuth complexity, latency (~200-400ms per command through the cloud vs. <50ms on LAN), and rate limits are stricter. For real-time-feeling color changes on records, LAN is the right call.

## 5. Architecture

```
┌────────────────────────┐    HTTP     ┌───────────────────────┐    HTTPS   ┌─────────────┐
│  Curator / Stylus /    │────────────>│  Hue Conductor        │───────────>│  Hue Bridge │
│  future scan sources   │  POST       │  (Fastify, headless)  │  CLIP v1   │  (LAN)      │
│                        │  /scan or   │                       │            │             │
│                        │  /playback  │  ┌─────────────────┐  │            └──────┬──────┘
└────────────────────────┘             │  │ Playback Engine │  │                   │
                                       │  │  - scheduler    │  │                   ▼
                                       │  │  - color mapper │  │            [ Hue Lights ]
                                       │  │  - rate limiter │  │
                                       │  └─────────────────┘  │
                                       └───────────────────────┘
```

Three logical modules inside the service:

1. **Bridge Adapter** — wraps the Hue library, handles pairing, discovery, connection health, and translation between the internal command shape and the bridge's CLIP v1 API (node-hue-api v4). The CLIP **v2** calls that Entertainment needs go through a separate small client (§9 "Streaming patterns", ADR 0024).
2. **Playback Engine** — takes a `PalettePayload`, resolves it against the currently selected room, produces a timeline of light commands, and dispatches them respecting rate limits. One playback active at a time.
3. **HTTP API** — the surface area for other services (Stylus for scan events, Curator for admin operations).

## 6. Data model

```typescript
// Persistent
type Bridge = {
  id: string; // Hue bridge ID
  ip: string;
  applicationKey: string; // Hue's term for the API key
  clientkey?: string; // DTLS PSK for Entertainment streaming (ADR 0024); absent on pre-DTLS pairings
  pairedAt: string; // ISO
};

type Settings = {
  listeningRoomId: string | null; // Hue room ID; null until Curator pushes one
  entertainmentAreaId: string | null; // Hue entertainment area for streaming (ADR 0024); null until set
  updatedAt: string;
};

type SavedPalette = {
  id: string; // uuid
  source: string; // "manual" | "curator:album:<curatorId>" | ...
  payload: PalettePayload; // see integration contract
  createdAt: string;
};

type PlaybackHistoryEntry = {
  id: string;
  paletteId: string;
  roomId: string;
  startedAt: string;
  endedAt: string | null;
  status: "playing" | "completed" | "stopped" | "errored";
};

// Runtime (in-memory)
type SessionSnapshot = {
  capturedAt: number; // performance.now()
  lights: Array<{
    lightId: string;
    on: boolean;
    xy?: [number, number];
    brightness?: number;
  }>;
};

type ActivePlayback = {
  paletteId: string;
  roomId: string;
  lightIds: string[];
  patternType: PatternType;
  startedAt: number; // performance.now()
  timers: NodeJS.Timeout[];
  sessionSnapshot: SessionSnapshot; // captured on idle→playing; preserved across palette swaps
};
```

## 7. HTTP API

All JSON. Runs on `http://localhost:4737` (arbitrary; pick something memorable).

### Setup

The pairing endpoints are called by a one-time CLI script (`pnpm run pair` in the conductor package on the Pi), not by any UI. The script discovers bridges, prompts the operator to press the link button, polls until pairing succeeds, and stores the application key. After that, ongoing operation is fully headless.

| Method   | Path                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/api/bridge/discover` | Uses mDNS + `discovery.meethue.com` fallback. Returns candidate bridges. Called by the pairing script.                                                                                                                                                                                                                                                                                             |
| ~~POST~~ | ~~`/api/bridge/pair`~~ | **Never implemented — pairing is a CLI, not a route (corrected 2026-07-25).** `pnpm pair` (`src/pair.ts`) polls the bridge for the link-button press and writes the application key (and DTLS clientkey) directly. That is the better design: pairing needs someone physically at the bridge, so it belongs to an operator command run on the Pi, not to an HTTP surface any LAN client could hit. |
| GET      | `/api/bridge/status`   | Returns paired state, bridge IP, last-seen. Called by Curator to show bridge health.                                                                                                                                                                                                                                                                                                               |
| GET      | `/healthz`             | 200 once the service is up; unauthenticated. Polled by the desktop shell and by Curator's connection test.                                                                                                                                                                                                                                                                                         |

### Discovery

| Method | Path          | Purpose                                                                                            |
| ------ | ------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/api/rooms`  | Lists Hue rooms/zones with their light IDs and light capabilities (color-capable? dimmable-only?). |
| GET    | `/api/lights` | Flat list of all lights.                                                                           |

### Scan events (from Stylus)

| Method | Path        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/scan` | Body: `{ event: "start" \| "stop", uri?, tagUid?, readerId, at }`. Called by Stylus. On `start`, resolves the URI to a palette+pattern from the local asset store and applies it to the configured listening room. If a playback is already active, crossfades from the current palette to the new one — this makes running through several albums back-to-back feel seamless (which happens naturally when showing the experience to visitors). On `stop`, fades to idle and restores the session snapshot. Auth via `X-Trigger-Secret` header. |

> **Implemented 2026-07-22 (issue #45 / [ADR 0019](../adrs/0019-conductor-scan-reads-asset-store.md)):**
> the first build that has Conductor **read the synced album-assets store** (via `config.albumAssetsDir`,
> default `{dataDir}/album-assets`) instead of only accepting pre-built payloads on `/api/playback`.
> The album→payload mapping (`buildPalettePayload`) now lives in `@marquee/contracts`, shared with
> Curator's Demo Room. A _valid_ scan Conductor can't act on — no listening room, album not synced,
> album not far enough along (no palette/pattern) — logs and returns `202 { action: "ignored", reason }`
> rather than erroring (runtime-overview §9); only a malformed body or non-`curator:album:` URI is a
> 4xx. The engine arms the 90-min idle timeout on `start`. (`/api/playback/current` + `/history` are
> now built — issue #54.)

### Playback (direct submission)

| Method | Path                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/playback`                  | Body: `{ roomId?, palette }`. Starts playback of the palette pattern. If `roomId` is omitted, uses the configured listening room. If a playback is already active, crossfades to the new palette (same session; no re-snapshot). A **streaming effect** (aurora/shimmer/wave) routes over the Entertainment API when an area is configured and returns `{ streaming: true, areaId, effect }` (else the CLIP fallback, [ADR 0024](../adrs/0024-entertainment-dtls-transport.md)); a CLIP pattern returns `{ playbackId }`. Shares one code path with `/api/scan`, so Curator's Demo Room and a manual `curl` can drive streaming too. |
| POST   | `/api/playback/stop`             | Stops current playback, restores the session snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/api/playback/current`          | The album(s) playing now, one per active room: `{ playback: [{ playbackId, roomId, source: { name, artist, year }, pattern, startedAt }] }`. Empty when idle (issue #54).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/api/playback/history?limit=50` | Recent playbacks, most-recent first (bounded ring, cap 50; `limit` ≤ 200). Each row adds `stoppedAt` once its playback ended; a mid-session album swap closes the previous row and opens a new one (issue #54).                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Settings (pushed from Curator)

| Method | Path            | Purpose                                                                                                                                                                                                                 |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings` | Returns current Conductor settings (`listeningRoomId`, `entertainmentAreaId`). Called by Curator to display current state.                                                                                              |
| PUT    | `/api/settings` | Body: `{ listeningRoomId?, entertainmentAreaId? }`. Curator pushes settings updates here. Only the keys present are changed (a partial PUT can't clear the other). Persisted to disk; used as defaults for `/api/scan`. |

### Entertainment (streaming, [ADR 0024](../adrs/0024-entertainment-dtls-transport.md))

| Method | Path                       | Purpose                                                                                                                                                                                                                 |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/entertainment/areas` | Lists the bridge's entertainment areas (id, name, per-channel positions) for Curator to pick a streaming target. **409** if the bridge is unpaired, or paired before the `clientkey` was captured (re-run `pnpm pair`). |

### Testing utilities

| Method   | Path                    | Purpose                                                                                                                                                                                                                                                                        |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST     | `/api/test/color`       | Body: `{ roomId, hex }`. Sets a single flat color. Used by Curator's admin operations and by curl for smoke testing.                                                                                                                                                           |
| ~~POST~~ | ~~`/api/test/restore`~~ | **Never implemented (noted 2026-07-25).** Restoring the pre-playback snapshot is what `POST /api/playback/stop` already does on the real path, so a separate test route earns little. Raise an issue if a snapshot-restore without an active playback is ever actually needed. |

## 8. Palette payload (integration contract)

**This is the shape both apps agree on. See `integration-contract.md` for the full schema and semantics.** The Conductor should validate incoming payloads with a JSON schema (Fastify makes this a one-liner) and return a helpful 400 on invalid input.

Quick preview:

```json
{
  "version": 1,
  "source": { "type": "album", "name": "Purple Rain", "artist": "Prince" },
  "palette": {
    "colors": [
      { "hex": "#4B0082", "role": "primary" },
      { "hex": "#8A2BE2", "role": "secondary" },
      { "hex": "#FFD700", "role": "accent" }
    ]
  },
  "pattern": {
    "type": "static",
    "params": {}
  }
}
```

## 9. Playback Engine details

### Supported pattern types

- `static` — assign palette colors to lights in the room. If more lights than colors, cycle. Set once, done.
- `rotate` — rotate the palette across the lights on an interval. Params: `{ intervalMs: number, direction: "forward" | "reverse" }`.
- `pulse` — hold a color; ramp brightness up and down. Params: `{ periodMs: number, minBrightness: 0-100, maxBrightness: 0-100 }`.
- `crossfade` — smoothly fade between palette colors on all lights together. Params: `{ transitionMs: number, holdMs: number }`.

That's the set the engine renders. _Which_ of these an album uses is chosen upstream by Palette Press, which is now **energy-aware** — a vivid palette gets `rotate`/`pulse` instead of always `crossfade`, read from the palette itself with no audio data required ([ADR 0022](../adrs/0022-palette-derived-motion-energy.md)). What still needs upstream data is live **beat**-sync (real-time audio-reactive effects at streaming rates), which remains a future extension gated on an audio input and the Entertainment API (§9 rate limiting).

### Streaming patterns (Entertainment API)

The four patterns above are all the CLIP path can do (~10 cmd/s/light, bridge-driven fades). Continuous
motion — a flowing aurora, a candlelight shimmer, a colour wave that physically sweeps the room — needs
the **Entertainment API**: a DTLS/UDP stream where Conductor pushes ~25 Hz frames to every light at
once. Built across [ADR 0023](../adrs/0023-entertainment-streaming-effect-engine.md) (engine) and
[ADR 0024](../adrs/0024-entertainment-dtls-transport.md) (transport):

- **The effects (`src/stream/renderers.ts`).** Pure, deterministic, unit-tested:
  - `aurora` — a 2D-noise flow field drifts each light's position along the palette gradient; colours
    bleed and morph, never quite repeating. Params `{ speed?, scale?, brightness? }`.
  - `shimmer` — the palette held across the lights with a per-light brightness twinkle. Params
    `{ speed?, intensity? }`.
  - `wave` — the palette sweeps across the lights' real **positions** in the room. Params
    `{ speed?, angleDeg? }`. This is the effect that needs per-light geometry.
- **The engine (`StreamEngine`)** samples a renderer at a fps-capped rate (default 25) and pushes each
  frame to a `StreamTransport` **port**; timers/clock are injected for deterministic tests. A throwing
  transport can't wedge the loop. `pnpm preview:stream` renders the effects to a self-contained HTML
  page to watch them without hardware. That page runs **one** animation loop for all effect cards,
  advances only when the content frame index actually changes, and stops entirely while the page is
  hidden — the loop lives in `stream/preview-driver.ts` and is inlined into the page (issue #135).
- **The transport (`DtlsStreamTransport`, ADR 0024)** encodes each frame as a HueStream v2 datagram
  (`encodeHueStreamFrame`) and sends it over a DTLS/PSK socket (`node-dtls-client`) to UDP 2100. A tiny
  CLIP v2 client (`Clip2Client`) lists entertainment areas (id, name, per-channel positions) and PUTs
  the area into/out of streaming mode. The DTLS handshake is the only piece verified on hardware.
- **The session (`StreamSession`)** ties it together for a scan: snapshot the room (CLIP) → PUT area
  streaming-on → open DTLS → run the engine; `stop` reverses it and restores the snapshot, under the
  same idle-timeout safety net as CLIP. On `/api/scan`, a streaming-effect album with an
  `entertainmentAreaId` configured hands off CLIP → streaming; with no area configured (or if the
  handshake fails) it **falls back to a lively CLIP pattern** — `rotate` for a multi-colour palette,
  `pulse` for a single colour — never a flat hold.

Streaming effects are **opt-in via a Curator per-album override**, not auto-selected — Palette Press
still defaults to CLIP patterns (the producer can't know whether a runtime has an entertainment area;
ADR 0024). The pattern types are in the `PalettePayload` contract so an override can request them.

### Palette transitions within a session

A "session" begins when Conductor transitions from idle to playing (typically a scan event on a sleeve going onto the empty stand). It ends when a stop event arrives or the idle timeout fires. Within a session, multiple palettes may play in sequence — swapping sleeves, or showing several albums in a row when a visitor is over.

Palette transitions within a session are **always crossfaded**, never abrupt. When a new palette arrives while one is playing:

1. Cancel the current pattern's active timers
2. Interpolate each light from its current color/brightness to the new palette's target color/brightness over `transitionMs` (default 1500ms — the same range as a normal `crossfade` pattern's step, tuned for feeling deliberate rather than jarring)
3. Once the transition completes, begin executing the new pattern

The session snapshot (§ State restoration) is **not** touched during palette transitions — it remains the original pre-session lighting, so `stop` restores what the room looked like before you first placed a sleeve, regardless of how many sleeves you cycled through.

### Listening room configuration

Conductor doesn't discover a "listening room" on its own. The room is configured by the user in Curator's settings and pushed to Conductor via `PUT /api/settings`. Conductor stores it on disk and uses it as the default room for scan events. If no room is configured, the admin `/api/playback` endpoint returns **400** with a helpful message pointing the user at Curator's settings; a runtime **`/api/scan`** with no room configured instead **degrades to `202 { action: "ignored" }`** and stays put ([ADR 0019](../adrs/0019-conductor-scan-reads-asset-store.md)) — a hardware scan must not error-storm the always-on service (runtime-overview §9).

The `/api/playback` endpoint accepts an explicit `roomId` for admin operations that need to target a specific room independent of the configured default (mostly for testing and one-off effects from Curator's UI).

Rationale for pushing rather than pulling: Curator is on the workstation and may be offline. Push-on-change ensures Conductor's state is current without requiring Curator to be reachable at scan time.

### Color space conversion

Album art gives you sRGB hex; Hue wants CIE xyY (color space) or hue/sat. Two options:

1. Let the library do it. `node-hue-api` has color conversion helpers built in.
2. Do it yourself with the standard sRGB → linear → CIE XYZ → xy pipeline, gamut-clamped to the light's model (A, B, C — different Hue models have different color gamuts). The `@q42philips/hue-color-converter` package on npm handles this precisely.

**Recommendation**: use option 1 by default; switch to option 2 if you notice colors landing wrong (typical failure mode: deep purples become blue because they're outside gamut A/B and get clamped incorrectly).

### Rate limiting

Hue's local API accepts roughly:

- **10 commands/sec per light** (light-scoped endpoints)
- **1 command/sec per group** (group-scoped endpoints)

The playback engine must throttle. Use a simple token bucket per light. When a pattern would exceed the rate, drop the interpolation steps rather than queue them (queuing causes drift and lag).

For anything faster than ~10 Hz total (the streaming effects, or future beat-sync), the **Entertainment API** is used instead — DTLS UDP streaming at ~25 Hz per light, a separate transport that bypasses this CLIP rate limit entirely (§9 "Streaming patterns"; [ADR 0024](../adrs/0024-entertainment-dtls-transport.md)). This rate limiter governs only the CLIP path.

### Session snapshot and restoration

On the transition from idle to playing, snapshot the current on/off/color/brightness of every light in the target room. Store as the `sessionSnapshot` on the `ActivePlayback` record. The snapshot is **preserved across palette transitions within the session** — swapping sleeves during an experience doesn't touch it, so the "restore" behavior always returns to what the room looked like before the session began.

On stop (manual, scan-driven, or idle timeout): restore the session snapshot, then clear it. Next session takes a fresh snapshot. This makes the service feel non-destructive — you can cycle through albums without permanently affecting the ambient state of the room.

### Idle timeout (safety net)

If Conductor is in an active session and no scan event or command has arrived in `idle_timeout_minutes` (default 90), automatically restore the session snapshot and end the session. This is the safety net for the "lost `stop` event" failure class described in the Stylus and Backdrop specs — a WiFi hiccup during sleeve removal can eat the removal event, and without this timeout, Purple Rain plays until you notice.

Not a substitute for reliable event delivery. Just insurance. Configurable via the same TOML config as the rest of Conductor.

## 10. Development milestones

Each milestone should end in a demoable state — verify before proceeding.

1. **Bridge pairing works.** Scaffold Fastify + TS project. Implement `/api/bridge/discover` and the `pnpm run pair` CLI (which talks to the bridge directly — see §8). Success: run `pnpm run pair` on the Pi; press link button; get an application key saved to SQLite.
2. **Read the world.** Implement `/api/rooms` and `/api/lights`. Success: `curl` returns your actual room names in JSON.
3. **Write to the world.** Implement `/api/test/color`. Success: POST a hex color, see the lights change.
4. **Static palettes.** Implement the `PalettePayload` schema + validator + `static` pattern in the playback engine. Success: POST the "Purple Rain" test payload, see the room take on the palette.
5. **Time-based patterns.** Add `rotate`, `pulse`, `crossfade` with a scheduler that respects rate limits. Success: rotate cycles cleanly at 2s intervals without dropped or duplicated commands.
6. **State snapshot / restore.** Snapshot on play, restore on stop. Success: play a palette, stop it, room is exactly as before.
7. **History + saved palettes.** SQLite persistence for palettes and playback history. Success: `curl` recent playbacks and see them.
8. **systemd auto-start.** Ships as a systemd unit; boots on power-up. Success: unplug the Pi, plug it back in, `curl` the status endpoint and see it healthy.

## 11. Known gotchas

- **Bridge TLS cert.** The Hue bridge presents a Signify-signed cert whose Common Name is the bridge ID, not the IP. Your HTTPS client has to resolve the bridge ID to the IP or use the Signify CA cert as an extra CA. `node-hue-api` handles this internally when using the discovery + connection flow. If you build any custom `fetch` calls (e.g., poking a raw endpoint the library doesn't wrap), either set `NODE_EXTRA_CA_CERTS` pointing to Signify's root, or (dev only, not production) `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Gamut clamping surprises.** Some album art colors literally can't be reproduced by Hue color bulbs. Deep saturated purples, true reds at low brightness, and near-blacks all land somewhere else than you'd expect. The generator will need to know this — see the Palette Press spec section on Hue-aware palette selection.
- **Groups vs. individual lights.** Group commands are subject to the 1 Hz limit. For patterns that touch multiple lights, address them individually and stagger — you get 10× the throughput.
- **The bridge's own scenes.** If a Hue scene is currently playing on the room (e.g. from the app), it can fight with your commands. Conductor stops any active scene on the target room before starting playback.
