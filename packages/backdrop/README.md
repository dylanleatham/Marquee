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
- **`server.ts`** — Fastify + `@fastify/websocket` + `@fastify/static`; every endpoint in spec §8
  (`/api/scan`, `/api/library/*`, `/api/admin/*`, `/api/status`, `/healthz`), `X-Trigger-Secret`
  auth on `/api/*` (SPA + `/ws` + `/healthz` stay open).
- **`public/`** — vanilla kiosk SPA: two `<video>` layers for crossfade, near-black idle gradient,
  auto-reconnecting WebSocket, `?debug=1` corner indicators.

Cross-service shapes (`ScanEvent`, `LibraryEntry`) live in `@marquee/contracts`.

## Dev

```bash
pnpm --filter @marquee/backdrop dev        # tsx watch on :4740 (auth disabled, warns at boot)
pnpm --filter @marquee/backdrop test       # vitest — 28 tests
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

## Deploy on the Pi (spec milestones 1, 10, 11 — hardware, not yet automated)

These need the actual Pi 5 + display and are documented here rather than built:

1. **Kiosk launcher.** Launch Chromium against the SPA as a **`file://` origin** so the `<video>`
   can load the local `file://` clips (a page served over `http://localhost` can't load `file://`
   resources — Chromium blocks cross-scheme). Bake in the autoplay flag now for a future un-mute:
   ```
   chromium-browser --kiosk --start-fullscreen --window-position=0,0 \
     --autoplay-policy=no-user-gesture-required \
     --app=file:///home/pi/backdrop/packages/backdrop/public/index.html?debug=0
   ```
   (Alternatively serve over `http://localhost:4740` **and** add `--allow-file-access-from-files`.)
   The SPA connects the WebSocket back to `ws://localhost:4740/ws` automatically.
2. **Disable screen blanking** so the panel doesn't go black and look crashed: `xset s off -dpms`
   in the session (spec §13).
3. **systemd units** — one for `node dist/server.js`, one for the Chromium launcher
   (`After=graphical.target`). Pull-the-plug → boots ready (spec milestone 10).
4. **NFC integration** — with Stylus running, a real tagged sleeve plays its visualizer; removing it
   fades to idle (spec milestone 11). This is the moment the runtime loop closes end-to-end.

Video **decode + crossfade quality** (seamless loop, no black flash at the seam) can only be judged
on the Pi with real H.264 clips; the SPA structure (two-element crossfade) is in place for it.
