# Spike — play a Spotify album over Sonos

**One question:** can a Node process on the LAN make a Sonos speaker play an arbitrary
`spotify:album:<id>`? That's the capability the official Sonos cloud API _can't_ give us; the
local UPnP layer (via [`@svrooij/sonos`](https://github.com/svrooij/node-sonos-ts)) can. Background:
[`docs/research/sonos-spotify-playback.md`](../../docs/research/sonos-spotify-playback.md).

This is a **throwaway spike**, deliberately outside the pnpm workspace (`spikes/*` isn't in
`pnpm-workspace.yaml`), so it installs and runs on its own with plain `npm` — nothing to wire into
turbo.

## ⚠️ Must run on your home network

The cloud dev container has no Sonos on its LAN, so this **cannot be tested from Claude Code on the
web**. Run it on your workstation or a Pi that shares the network with the speakers.

## Prerequisites

- Node 20–22.
- **Spotify added** as a service in the Sonos app, **Premium**, and **at least one Spotify album
  saved as a Sonos Favorite (♡).** That favorite is how the spike learns your account's real Spotify
  binding (see below). The spike never authenticates to Spotify — it drives the account Sonos knows.

## How it actually plays an album (the hard part)

`@svrooij/sonos`'s `AddUriToQueue('spotify:album:…')` builds a container URI with a **hardcoded**
service id and account serial (`sid=9`, `sn=7`) — which don't match a real household, so Sonos
rejects it with `UPnPError 800`. Modern Sonos also hides the linked account behind cloud auth, so
`/status/accounts` comes back empty and can't tell us the right values.

The spike solves this by **mimicking a Sonos Spotify favorite**: it browses your Favorites (`FV:2`),
reads the real `sid`, `sn`, and `cdudn` token from an existing Spotify favorite, and builds the
container URI + DIDL metadata for the target album using those. The binding is account-level, so any
one Spotify favorite unlocks playing _any_ album. (This reverse-engineering is exactly the fragility
that makes Path B / the official Spotify Web API — see [`../spotify-connect`](../spotify-connect) —
attractive for the real service.)

## Run

```bash
cd spikes/sonos-spotify
npm install

# 1) inspect (optional): topology, favorites (shows sid/sn), raw accounts
node play-album.js --list
node play-album.js --speaker "Living Room" --favorites
node play-album.js --speaker "Living Room" --accounts

# 2) play — derives sid/sn/token from your favorites automatically
node play-album.js --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3

# stop
node play-album.js --speaker "Living Room" --stop

# override the binding instead of deriving (values from --favorites)
node play-album.js --speaker "Living Room" --album spotify:album:… \
  --sid 12 --sn 1 --token "SA_RINCON3079_X_#Svc3079-0-Token"
```

> **Call `node play-album.js` directly, not `npm run play -- …`.** On Windows especially, npm eats
> the flags as its own config and forwards only bare values. The script also reads two positionals
> (`node play-album.js "Living Room" spotify:album:…`), so either form works — but `node` is cleanest.

## Reading the result

- `→ binding: sid=… sn=… token=…` then `▶ playing on <room>` → **viable.** Local UPnP can trigger an
  album by URI. Green-light the "Amp" design (Path A).
- `Could not derive the Spotify binding: no Spotify favorite found` → save one Spotify album to Sonos
  Favorites and retry (or pass `--sid --sn --token`).
- `UPnPError 800` still → the derived binding didn't match; re-run `--favorites` and pass the values
  explicitly, or the album isn't available in your Spotify market.
- **Grouped / bonded speakers** (stereo pairs, joined rooms) are handled automatically: queue
  commands route to the group coordinator, shown as `via coordinator <name>`.

## What this spike does NOT decide

Only viability. The **card-vs-sleeve routing** — cards trigger audio, sleeves don't — is an
application concern that lands in the real service, not here. The scan event today
(`{ event, uri, tagUid, readerId }`) carries the same `curator:album:<id>` for both objects, so the
future "Amp" service needs a way to tell them apart. Two options, to settle in an ADR + spec once
viability is proven:

1. **UID lookup (no re-tagging):** the album-assets store already tracks the sleeve and card tags
   separately — if it records each object's tag UID, Amp maps the scanned `tagUid` → object kind and
   only plays for cards. Cleanest; no schema change, no re-writing stickers.
2. **Encode the kind in the tag:** write a `kind`/`obj=card` marker into the tag payload and surface
   it on the scan event. More explicit, but changes the integration contract and means re-tagging.

Either way, Amp subscribes to the same Stylus `start`/`stop` events as Conductor and Backdrop, reads
the Spotify URI already in the asset store, and — for card scans only — calls the playback path this
spike proves out.
