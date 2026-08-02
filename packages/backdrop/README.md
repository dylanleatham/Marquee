# Backdrop

Node backend + Chromium kiosk SPA that plays looping visualizer videos on the display in response
to NFC scan events. Spec: [../../docs/specs/backdrop-spec.md](../../docs/specs/backdrop-spec.md).

Runs on `http://0.0.0.0:4740`. Stylus POSTs scan events; Curator pushes the URI→video map; the
kiosk browser connects over WebSocket and shows the video.

## What's built (the workstation-testable core — spec milestones 2–9)

- **`config.ts`** — port/host/secret/dataDir/mediaDir/idleTimeout from `config.toml` + env + defaults
  (same loader shape as Conductor).
- **`library.ts`** — the URI→video-file map (`library.json`), atomic writes, tolerant of a corrupt file.
- **`controller.ts`** — the `IDLE ⇄ PLAYING` state machine (spec §7): scan → resolve → broadcast a
  `play`/`stop` command, idle-timeout safety net (injectable timers), and graceful handling of an
  unknown URI or a missing/out-of-tree file (stay put, flash a corner hint — never blackscreen).
- **`hub.ts`** — WebSocket fan-out to the connected browser(s).
- **`quality.ts`** — turns the kiosk's `getVideoPlaybackQuality()` counters into a dropped-frame
  verdict for `/api/status` (spec §8, [ADR 0046](../../docs/adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)).
  The Pi decodes H.264 in software and Curator's preview can't see that, so this is the only
  measurement of whether a visualizer actually plays on the hardware.
- **`server.ts`** — Fastify + `@fastify/websocket` + `@fastify/static`; every endpoint in spec §8
  (`/api/scan`, `/api/library/*`, `/api/admin/*`, `/api/status`, `/healthz`), `X-Trigger-Secret`
  auth on `/api/*` (SPA + `/ws` + `/healthz` stay open).
- **`public/`** — vanilla kiosk SPA: two `<video>` layers for crossfade, near-black idle gradient,
  auto-reconnecting WebSocket, `?debug=1` corner indicators. The layers swap roles the moment a clip
  goes on screen, never on a timer — a timer-based swap left the "spare" layer pointing at the video
  being watched for the length of every fade
  ([ADR 0046](../../docs/adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)).

Cross-service shapes (`ScanEvent`, `LibraryEntry`) live in `@marquee/contracts`.

## Dev

```bash
pnpm --filter @marquee/backdrop dev        # tsx watch on :4740 (auth disabled, warns at boot)
pnpm --filter @marquee/backdrop test       # vitest — 100 tests
pnpm --filter @marquee/backdrop type-check
```

Open `http://localhost:4740/?debug=1` to see the SPA. Drive it without hardware:

```bash
curl -XPOST localhost:4740/api/library/update -H content-type:application/json \
  -d '{"uri":"curator:album:demo","filePath":"C:/abs/path/under/media_dir/demo.mp4"}'
curl -XPOST localhost:4740/api/scan -H content-type:application/json \
  -d '{"event":"start","uri":"curator:album:demo","tagUid":"04:A1","at":"now"}'  # → video plays
curl -XPOST localhost:4740/api/scan -H content-type:application/json \
  -d '{"event":"stop","at":"now"}'                                # → fades to idle
```

`filePath`s must sit under `mediaDir` (defense-in-depth against a poisoned library).

## Deploy on the Pi

**[DEPLOY.md](DEPLOY.md) is a full step-by-step guide** for a first-time Pi user — from flashing the
SD card to a Pi that boots straight into Backdrop (spec milestones 1, 10, 11). In short it covers:
flash Raspberry Pi OS → install Node 22 + Chromium → clone & build → `config.toml` → a systemd unit
for the backend → an X11 auto-login kiosk that launches Chromium at the SPA as a **`file://` origin**
(required so the `<video>` can load the local `file://` clips — Chromium blocks `file://` from an
`http://` page) → pull-the-plug boot test → wiring Stylus + Curator to it.

Video **decode + crossfade quality** (seamless loop, no black flash at the seam) can only be judged
on the Pi with real H.264 clips; the SPA structure (two-element crossfade) is in place for it.
