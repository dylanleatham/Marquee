# Research — playing a Spotify album over Sonos

_Status: research note, not a decision. Dated 2026-07-23. If we act on this, promote the chosen
approach to an ADR + a service spec (see "Fit with Marquee" below)._

**Question:** Does Sonos expose an API or SDK that would let Marquee play an album from Spotify over
the Sonos speakers in the house?

**Short answer:** Yes — there are three viable layers, and the one that actually lets you say "play
_this_ Spotify album by URI" without a partner agreement is the **local UPnP control layer**
(reachable today from Node or Python libraries on the LAN). The **official Sonos Control API** is
real and supported but is oriented toward music-service partners and Favorites, so it can't queue an
arbitrary `spotify:album:…` URI on its own. A Spotify account (historically Premium for control) must
already be linked inside the Sonos app in every case.

---

## The three layers

### 1. Official Sonos Control API (cloud) — supported, but limited for our use case

- REST + webhook/websocket API at `developer.sonos.com`. Register an app, OAuth against a Sonos
  account, then control groups, playback, volume, and playback sessions across households.
- **What it does well:** transport control (play/pause/skip), grouping, volume, and `loadFavorite`
  (play something the user has already saved as a Sonos Favorite), plus `loadCloudQueue` for a queue
  you host on your own server.
- **What it can't do for us:** it cannot take a raw `spotify:album:<id>` and queue it. The cloud
  queue / `playbackSession` machinery is designed for **music-service partners** (the SMAPI model) —
  it plays content from the service that owns the session, not arbitrary third-party Spotify content.
  Community threads confirm the official API "cannot queue Spotify items" and is "intended primarily
  for music services themselves; you can only play Favorites and a few other limited things."
- **Workaround if we went this route:** pre-save each album as a **Sonos Favorite**, then call
  `loadFavorite` by id at scan time. Works, but every album needs a one-time manual Favorite created
  in the Sonos app — friction that fights Marquee's "add an album, walk away" onboarding.
- **Cost:** adds a cloud dependency + OAuth, which cuts against Marquee's LAN-first, "everything is
  local" philosophy (runtime-overview §11).

### 2. Local UPnP control — the layer that actually plays an album by URI

Sonos players speak UPnP/SOAP on the LAN. That interface (undocumented but stable-in-practice) can
add a Spotify album to the queue by constructing a container URI plus DIDL-Lite metadata — the same
"share link" mechanism the Sonos app uses internally:

```
x-rincon-cpcontainer:1004206cspotify:album:<id>?sid=9&flags=8300&sn=<accountSerial>
```

Then `AddURIToQueue` (not `SetAVTransportURI`) with the matching DIDL-Lite metadata, and play.

- **Requires:** Spotify already added as a music service in the household's Sonos app; the correct
  service id (`sid`) and account serial (`sn`) for that household.
- **Caveats:** unofficial surface — a firmware update _could_ change it; the `sid`/`sn` values are
  per-household and must be discovered. In practice these libraries have tracked Sonos for years and
  expose a "share link" helper so you don't hand-build the URI.

Libraries that implement this today:

| Library | Lang | Notes |
| --- | --- | --- |
| [`@svrooij/sonos`](https://sonos.svrooij.io/) (sonos-ts) | TypeScript | Actively maintained, typed, has a Spotify share-link helper. **Best fit for our Node/TS monorepo.** |
| [`node-sonos`](https://github.com/bencevans/node-sonos) | JS | Long-standing, lower-level. |
| [`SoCo`](https://github.com/SoCo/SoCo) | Python | Mature; `sharelink` adds Spotify track/album/playlist to the queue. |
| [`node-sonos-http-api`](https://github.com/jishi/node-sonos-http-api) | JS | HTTP bridge over the above; hostable on a Pi. `/<room>/spotify/now/spotify:album:<id>` and `/<room>/musicsearch/spotify/album/<query>`. |

### 3. `node-sonos-http-api` (jishi) — the pragmatic bridge

A thin HTTP service wrapping the local UPnP layer, explicitly designed to run on "a raspberry pi or
similar." You `POST`/`GET` a URL and a room plays. It already has first-class Spotify endpoints
(play a `spotify:album:` URI, or search-and-play by album name). Because it's a small LAN HTTP
service on a Pi, it maps almost 1:1 onto how Marquee already talks to Conductor and Backdrop.

---

## Fit with Marquee

Marquee **plays no audio today** — the tag is only an identifier, and the human physically drops the
needle on a real record (runtime-overview §11: "Audio identification … the tag is the identifier";
audio is deliberately out of scope). Playing the Spotify album over Sonos would be a **new
capability and a concept shift** — the sleeve becomes a trigger to _stream_ the album, not (only) a
cue to play vinyl. That's an architectural decision worth an ADR + design discussion before we
build, not a silent addition.

If we do it, it slots cleanly into the existing fan-out model:

- Add a new sibling runtime service — call it **"Amp"** to match the backstage naming — that
  subscribes to the same Stylus scan event (`{event:"start", uri, …}`) that Conductor and Backdrop
  already receive, alongside them.
- The album-assets store **already carries the Spotify URI** ("Spotify URI if available",
  runtime-overview §4), so the `curator:album:<id>` → `spotify:album:<id>` mapping exists. Amp reads
  it the same way Conductor reads palette/pattern.
- On `start`, Amp tells Sonos to play the album; on `stop`, it pauses/stops the group. Same
  degrade-gracefully rules as the other services (no Spotify URI → quiet no-op indicator).
- **Recommended implementation:** the local layer, not the cloud API — either `@svrooij/sonos`
  in-process (best fit for the TS monorepo) or `node-sonos-http-api` as a separate LAN service on the
  Pi. Both keep us LAN-only and can play an arbitrary album URI without a partner agreement or a
  per-album manual Favorite.

**Open questions to resolve in the ADR:** Spotify Premium requirement and how the account is linked;
which room(s)/group Amp targets and how that's configured; how audio start/stop interacts with the
lights/video timing (and with someone actually playing vinyl); resilience to Sonos firmware changes
in the unofficial UPnP surface.

---

## Sources

- [jishi/node-sonos-http-api](https://github.com/jishi/node-sonos-http-api) and its
  [Spotify action](https://github.com/jishi/node-sonos-http-api/blob/master/lib/actions/spotify.js)
- [@svrooij/sonos metadata / share-link docs](https://sonos.svrooij.io/metadata)
- [bencevans/node-sonos API](https://github.com/bencevans/node-sonos/blob/master/API.md)
- [SoCo issue #88 — add Spotify tracks/albums to queue](https://github.com/SoCo/SoCo/issues/88)
- [Sonos Developer — load cloud queue](https://developer.sonos.com/reference/control-api/playbacksession/load-cloud-queue/)
- [Sonos Community — "How to queue a Spotify track through API?"](https://en.community.sonos.com/smart-home-integrations-229108/how-to-queue-a-spotify-track-though-api-6864263)
- [Sonos Community — "How to implement Spotify"](https://en.community.sonos.com/controllers-and-music-services-228995/how-to-implement-spotify-6856968)
