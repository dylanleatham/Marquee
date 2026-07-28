# Spike — desk audio for bench preview ([#93](https://github.com/dylanleatham/Marquee/issues/93))

**One question:** how does a track from the album come out of the **workstation's** speakers while a
producer judges a sleeve in bench preview ([curator-ui-ux §6.1](../../docs/specs/curator-ui-ux.md))?
Three routes were on the table and the choice changes the packaging, so it was the open question in
[§11](../../docs/specs/curator-ui-ux.md) rather than a design. Outcome recorded in
[ADR 0037](../../docs/adrs/0037-bench-preview-audio-via-spotify-connect.md).

Like the other spikes here it lives **outside the pnpm workspace** with **no dependencies** — Node's
built-in `fetch` and the `electron` already installed for `@marquee/desktop`. Nothing to install.

## Prerequisites

- **Spotify connected in Curator** — the probe mints its own access token from the stored PKCE
  refresh token (`~/marquee/spotify-tokens.json`) + client id (`~/marquee/settings.json`), same trick
  as [`../spotify-connect`](../spotify-connect). Otherwise pass `--token` / `SPOTIFY_TOKEN`.
- **Spotify Premium** and the **desktop Spotify client running on this machine** — that is the thing
  route B plays on.
- At least one album in the asset store with a `spotifyUri` (the probe picks one automatically), or
  pass `--album`.

## Run

```powershell
cd spikes/desk-audio

node probe.js                 # every probe, with a verdict per route
node probe.js --clips         # A: is preview_url populated for this app?
node probe.js --devices       # B: which Connect devices can we see?
node probe.js --play          # B: actually play the album at the desk
node probe.js --stop          # pause it again

# pick the album (Spotify URI/URL or a Curator curatorId) or the device
node probe.js --play --album g4ae1t89 --device "My Laptop"
```

Route C needs a browser engine, not Node — run `widevine.html` inside the desktop app's own Electron:

```powershell
npm run widevine   # = node ../../packages/desktop/node_modules/electron/cli.js run-in-electron.cjs
```

(`npm run` is fine for that one because it takes no flags. Call `probe.js` with `node` directly —
on Windows npm eats `--speaker`-style flags as its own config, the same trap
[`../sonos-spotify`](../sonos-spotify) documents.)

(Exit code 0 = Widevine present, 2 = ran fine and it's absent, 1 = the probe itself failed. Opening
`widevine.html` in a plain Chrome tab is the useful control — Chrome has Widevine, so a `NO` there
means the probe is broken, not the runtime.)

## Reading the result

| Probe               | Says                                  | Means                                                       |
| ------------------- | ------------------------------------- | ----------------------------------------------------------- |
| A `--clips`         | `n/14 have preview_url` with n > 0    | Clips route is live — an `<audio>` tag is all you need      |
| A `--clips`         | `VERDICT A: DEAD`                     | Spotify isn't issuing `preview_url` to these credentials    |
| B `--devices`       | a device of type `Computer`           | The desk client is visible and targetable                   |
| B `--play`          | `▶ playing on <device>`               | **Audio is coming out of the workstation**                  |
| B `--play`          | `403 … Player command failed`         | Account isn't Premium, or the grant lost the playback scope |
| C `run-in-electron` | `NO — com.widevine.alpha unavailable` | Web Playback SDK needs a castlabs Electron build            |

Route A checks the field on three differently-shaped objects (album tracks, the full track object,
search hits) because a `null` on one is not proof of a `null` on the others.

## What it found (2026-07-27, Windows 11, Spotify Premium, Electron 33.4.11)

- **A — `preview_url` clips: DEAD.** `0/14` album tracks, `null` on the full track object, `0/5`
  search hits. The field is simply not issued to this app's client id.
- **B — Connect transfer: VIABLE.** The `[Computer]` device showed up idle (`active=false`) and
  `PUT /me/player/play?device_id=…` started the album on it, confirmed by reading `/me/player` back.
  Note this is the same call
  [ADR 0034](../../docs/adrs/0034-amp-sonos-playback-and-card-uri.md) rejected for Amp; it failed
  there because a Connect call cannot wake an **idle Sonos**, and a desktop client that is merely
  paused is a different case — it is already a live Connect target.
- **C — Web Playback SDK: DEAD as packaged.** Stock Electron 33.4.11 answers
  `NotSupportedError` for `com.widevine.alpha` (ClearKey succeeds in the same run, so the probe
  works). Viable only behind a castlabs Electron build.

## What this spike does NOT decide

Only viability, and only for the transport. Two application concerns land in the real build, not
here — both recorded in [ADR 0037](../../docs/adrs/0037-bench-preview-audio-via-spotify-connect.md):

1. **Bench preview must never target a room speaker.** Route B works by aiming at a device id; aim it
   at the Sonos and "touches no hardware, ever" (§6.1) becomes false. The device filter is part of
   the promise, not a convenience.
2. **It takes over the producer's own Spotify client**, replacing whatever they were listening to.
   That's a side effect on a human and needs saying in the UI, per §10.
