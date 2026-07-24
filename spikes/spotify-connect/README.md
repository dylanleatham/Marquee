# Spike (Path B) — play a Spotify album on Sonos via Spotify Connect

The **official** route, and the counterpart to [`../sonos-spotify`](../sonos-spotify) (Path A, local
UPnP). It never touches Sonos's API: it asks the **Spotify Web API** to start an album on the Sonos
speaker, which shows up as a Spotify Connect device. Same thing as picking the speaker inside the
Spotify app — driven by code. Background: [`docs/research/sonos-spotify-playback.md`](../../docs/research/sonos-spotify-playback.md).

**No dependencies** — uses Node's built-in `fetch` (Node 20+). Nothing to `npm install`.

## ⚠️ Run on your home network

The Sonos speaker only shows up as a Connect device to an account on the same system. Run this where
you'd run the Spotify app.

## Prerequisites

- **Spotify Premium** — Connect playback control is Premium-only. (Free accounts get 403.)
- A user token with `user-read-playback-state` + `user-modify-playback-state`. **You almost certainly
  already have this:** Marquee's Curator implements Authorization Code + PKCE with exactly these
  scopes (ADR 0014). If you've connected Spotify in Curator, this spike **mints its own access token**
  from Curator's stored refresh token (`~/marquee/spotify-tokens.json`) + client id
  (`~/marquee/settings.json`) — nothing to paste. Otherwise pass `--token` / `SPOTIFY_TOKEN`.

## Run

```powershell
# If you've connected Spotify in Curator, no token needed — it mints one:
node play-album.js --devices                                   # list Connect devices
node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
node play-album.js --stop

# Not using Curator? Supply a token instead:
$env:SPOTIFY_TOKEN = "BQ...your token..."
node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3

# Non-default Curator data dir:
node play-album.js --data-dir "D:\marquee" --devices
```

If Curator's data dir isn't `~/marquee`, point at it with `--data-dir` (or `MARQUEE_DATA_DIR`).
Individual overrides: `--client-id`, `--refresh-token`.

## Reading the result

- `▶ playing on Living Room — <artist> — <track>` → **Path B viable.**
- **`No Connect devices visible`** → open Spotify and cast to the Sonos speaker once so it registers,
  then retry. Targeting it by id afterwards will wake it.
- **`No Connect device matching …`** → it prints the names it can see; copy one (matching is a
  case-insensitive substring, so `--speaker Living` is enough).
- **`403 …`** → the account isn't Premium, or the token lacks the playback scopes.
- **`404 … NO_ACTIVE_DEVICE`** → shouldn't happen here (we target by id), but if it does, run
  `--devices`, cast once from the app, and retry.

## Why this might be the better path for the real service

- Official, documented Spotify API — not the unofficial Sonos UPnP surface that Path A rides.
- Reuses Marquee's existing Spotify OAuth plumbing (Roadie already calls the Web API).
- Resilient to the Sonos firmware direction we hit in Path A (cloud-managed service auth, empty
  `/status/accounts`, hardcoded `sn`).

Trade-offs vs Path A: needs Premium; depends on the speaker being a visible Connect target; control
goes through Spotify's cloud rather than staying purely on the LAN.
