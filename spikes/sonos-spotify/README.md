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
- **Spotify already added** as a service in the Sonos app (Settings → Services → Add). Playback
  control has historically needed **Spotify Premium**. The spike does not authenticate to Spotify —
  it drives the account Sonos already knows about.

## Run

```bash
cd spikes/sonos-spotify
npm install

# by room name (uses SSDP discovery)
npm run play -- --speaker "Living Room" --album spotify:album:1DFixLWuPkv3KT3TnV35m3

# or by IP (more reliable on segmented/VLAN networks), with a share URL
node play-album.js --speaker 192.168.1.42 \
  --album https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3

# stop
node play-album.js --speaker "Living Room" --stop
```

### Region

`--region` sets the Sonos Spotify service id. Default `3079` (US); EU is `2311`. **A wrong region is
the usual reason an album queues but won't start** — if playback is silent, try the other one.

## Reading the result

- `▶ playing on <room> — now: <track>` → **viable.** We can trigger album playback by URI. Green-light
  the "Amp" service design.
- Errors to expect while dialing it in: `No Sonos devices found` (wrong LAN / firewall on SSDP),
  `No speaker named …` (it prints the names it found — copy one), or it queues but stays silent
  (region, or Spotify not linked / not Premium).

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
