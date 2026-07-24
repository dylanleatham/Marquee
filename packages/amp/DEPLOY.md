# Amp on the runtime Pi — deploy & run

Amp is a **headless** Node service (like Hue Conductor — no display, no browser). It runs on the
runtime Pi, sibling to Conductor, and plays a **card**-scanned album over your Sonos. This guide is
the Pi bring-up; to hack on Amp on your laptop see [amp-spec](../../docs/specs/amp-spec.md) and just
`pnpm --filter @marquee/amp dev`.

It's much shorter than [Backdrop's DEPLOY](../backdrop/DEPLOY.md) because there's no kiosk browser —
if you've already set up a runtime Pi for Conductor, you're mostly adding one more systemd service.

## 0. Prerequisites

- A Raspberry Pi on the **same LAN as your Sonos speakers** (the runtime Pi that already runs
  Conductor is ideal — Amp is another headless Node service beside it). Node 22 + git + pnpm, exactly
  as in Backdrop DEPLOY §5–6.
- On the **Sonos** side (these are environment facts, not code — Amp degrades to a logged "ignored"
  if any is missing, it never crashes):
  - **Spotify added** in the Sonos app (Settings → Services), on a **Premium** account.
  - **At least one Spotify album saved as a Sonos Favorite** — Amp reads it to derive your account's
    real Spotify binding (`sid`/`sn`/token). Any one favorite unlocks playing every album.

## 1. Get the code and build

```
$ cd ~/Marquee && git pull        # or clone per Backdrop DEPLOY §6 if this is a fresh Pi
$ pnpm install
$ pnpm --filter @marquee/amp build
```

That compiles Amp **and** its `@marquee/contracts` dependency to
`~/Marquee/packages/amp/dist/server.js` — the file systemd runs.

## 2. Configure

```
$ cd ~/Marquee/packages/amp
$ cp config.example.toml config.toml
$ nano config.toml
```

Set the **shared secret** (the same value Conductor/Backdrop/Stylus use) and your **Sonos target
room**:

```toml
[auth]
shared_secret = "the-same-secret-your-other-services-use"

[sonos]
target_room = "Living Room"   # the exact Sonos room/group name; or set it later via PUT /api/settings
```

Defaults for everything else are fine: port **4741**, `data_dir = "data"`,
`idle_timeout_minutes = 90`. Curator rsyncs the album-assets store to `data/album-assets` (same target
Conductor reads) — point `[storage].album_assets_dir` elsewhere if your sync lands somewhere else.

## 3. Smoke-test by hand

```
$ node ~/Marquee/packages/amp/dist/server.js
```

You should see `Server listening at http://0.0.0.0:4741`. In a second SSH session (replace `SECRET`):

```
$ curl -s http://localhost:4741/healthz
$ curl -s -H "X-Trigger-Secret: SECRET" http://localhost:4741/api/sonos/rooms   # confirm your room name is listed
$ curl -s -H "X-Trigger-Secret: SECRET" -H "content-type: application/json" \
    -X POST http://localhost:4741/api/admin/play \
    -d '{"spotifyUri":"spotify:album:1DFixLWuPkv3KT3TnV35m3"}'
```

The last call should start audio on the target room. Stop it, then Ctrl+C the server:

```
$ curl -s -H "X-Trigger-Secret: SECRET" -X POST http://localhost:4741/api/admin/stop
```

## 4. Make it start on boot (systemd) — the unit

`systemd` keeps Amp alive and restarts it on failure or reboot. Create the service file:

```
$ sudo nano /etc/systemd/system/amp.service
```

Paste this (assumes username `pi`; adjust the paths if you used a different username):

```ini
[Unit]
Description=Marquee Amp — Sonos audio for card scans
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Marquee/packages/amp
ExecStart=/usr/bin/node /home/pi/Marquee/packages/amp/dist/server.js
Restart=on-failure
RestartSec=3
# Log to journald (bounded) rather than a file that grows forever and wears the SD card.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now amp
$ systemctl status amp          # "active (running)"; q to exit
$ journalctl -u amp -f          # live logs; Ctrl+C to stop watching
```

Amp now survives reboots and restarts if it crashes. Confirm by pulling the power, waiting, and
re-checking `systemctl status amp` after boot.

## 5. Connect Amp to the rest of Marquee

Amp just waits for HTTP on port **4741**; two things drive it over the LAN:

- **Stylus** POSTs scan events to `/api/scan` with the shared secret. A **card** scan
  (`curator:card:<id>`) plays the album; a **sleeve** (`curator:album:<id>`) is ignored — you play the
  vinyl. (Conductor and Backdrop react to both, for lights and video.)
- **Curator** (on your workstation) keeps Amp current: it rsyncs the album-assets store to Amp's
  `album_assets_dir` (so `metadata.spotifyUri` is available at scan time), and can push the target
  room with `PUT /api/settings` (`{ "targetRoom": "Living Room" }`) instead of editing `config.toml`.

## 6. Updating Amp later

```
$ cd ~/Marquee && git pull && pnpm install
$ pnpm --filter @marquee/amp build
$ sudo systemctl restart amp
```

## 7. Troubleshooting

| Symptom                                                                         | Likely cause / fix                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `systemctl status amp`: won't start                                             | `journalctl -u amp -e`. Common: wrong path/username in the unit, or the build (step 1) never ran so `dist/server.js` is missing. |
| Card scan does nothing; log says `sonos unavailable: no Spotify favorite found` | Save one Spotify album as a Sonos Favorite in the Sonos app — Amp derives the account binding from it.                           |
| Log says `no Sonos room named "…"`                                              | The `target_room` must match a name from `GET /api/sonos/rooms` exactly (case/spacing count).                                    |
| Card scan logs `album not synced` / `album not on spotify`                      | Curator hasn't rsynced this album's asset yet, or the album has no `metadata.spotifyUri`. Both degrade to silence by design.     |
| `401 unauthorized` from a `curl`                                                | `X-Trigger-Secret` header must equal `config.toml`'s `shared_secret`.                                                            |
| Audio keeps playing after you lift the card                                     | A lost `stop` event; Amp's 90-min idle timeout is the backstop. Force it now: `POST /api/admin/stop`.                            |
