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
- A user **access token** with scopes `user-read-playback-state` and `user-modify-playback-state`.
  For a spike, the quickest source is the token generator on the Spotify Web API docs
  (<https://developer.spotify.com/documentation/web-api>) — request those two scopes. Tokens last
  ~1 hour; that's fine for proving viability. The real Amp service would use the Authorization Code
  + refresh-token flow (which Marquee's existing Spotify OAuth for Roadie can be extended to cover).

## Run

```powershell
# PowerShell
$env:SPOTIFY_TOKEN = "BQ...your token..."
node play-album.js --devices                                   # list Connect devices
node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
node play-album.js --stop
```

```bash
# bash
export SPOTIFY_TOKEN="BQ...your token..."
node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3
```

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
