# Amp — Technical Spec

_Plays a card- or demo-scanned album's audio over the house Sonos. The audio leg of the fan-out,
alongside Conductor (lights) and Backdrop (video)._

> **Status (2026-07-24): core built + tested; real Sonos driver pending LAN verification.** Decision
> in [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md); viability proven by the spikes under
> [`spikes/sonos-spotify`](../../spikes/sonos-spotify) (Path A, chosen) and
> [`spikes/spotify-connect`](../../spikes/spotify-connect) (Path B, rejected for cold-start).
> **Built** (`packages/amp`, milestones 1–4, 6–7): the `curator:card` contract change +
> `parseCuratorUri`; Conductor/Backdrop accepting `card`; the Fastify service with the card-gated
> `/api/scan`, settings, idle timeout, and a `FakeSonosDriver` (24 amp tests, all green); Stylus
> forwarding `card` URIs. **Milestone 5** — the real `SvrooijSonosDriver` — is written behind the
> port but can't run in CI (no Sonos); verify it on the LAN with `POST /api/admin/play`. Research:
> [sonos-spotify-playback.md](../research/sonos-spotify-playback.md).
>
> **Amended 2026-08-08 ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)):** a **third**
> kind, `curator:demo:<id>`, plays the album's one chosen track (`asset.demoTrack`) instead of the
> whole record, falling back to the album when nothing has been chosen. Amp's shape is unchanged — one
> more branch on `parsed.kind` and one more field read off the synced asset — but it is the first time
> Amp hands Sonos a `spotify:track:` URI, which surfaced a real `patchContainerUri` bug (§10). The
> milestone list in §14 is the original build's record and is left as history; the sections above it
> describe today.

## 1. Purpose

A local, headless service that, when a **card** or a **demo tag** is placed on the stand, plays that
album (or its one chosen track) from Spotify over the household Sonos speakers — so albums you don't own on vinyl still get the full Marquee
treatment (lights + video + now audio). When a **sleeve** is placed, Amp stays silent: you have the
record, you drop the needle. Amp knows how to talk to Sonos; it knows nothing about lights or video.

## 2. Success criteria

**Place a card on the stand → the album starts playing on the configured Sonos target within ~2s,
from a cold/idle speaker. Lift it (or place a different card) → audio stops or swaps. Place a
_sleeve_ → Amp does nothing.** If yes, the audio leg is viable and Marquee is no longer silent for
streaming-only records.

## 3. Scope

### In scope

- `POST /api/scan` accepting the shared `ScanEvent` (same shape Conductor/Backdrop accept)
- Gating on URI kind: play for `curator:card:<id>` and `curator:demo:<id>`, ignore `curator:album:<id>`
- Resolving a card's `curator:card:<id>` → the album's `metadata.spotifyUri`, and a demo tag's
  `curator:demo:<id>` → the album's chosen `demoTrack.spotifyUri`
  ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)), both via the synced album-assets store
- Playing / stopping a `spotify:album:<id>` **or `spotify:track:<id>`** on a configured Sonos target
  via local UPnP
- Deriving the household's Spotify binding (`sid`/`sn`/`cdudn` token) from a Sonos favorite
- Graceful degradation (202 "ignored") for anything it can't act on
- The 90-minute idle-timeout safety net for lost `stop` events
- `X-Trigger-Secret` auth; TOML+env config; a persisted target setting pushed from Curator

### Out of scope (but designed around)

- Multi-room / `readerId` → target mapping (single configured target for now)
- Volume ducking / coordinating with a real turntable's audio
- Spotify Connect ("resume on an already-casting device") — proven but rejected as the trigger path
  ([ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md)); the seam stays thin enough to add later
- Its own UI — headless; the target is configured in Curator and pushed via `PUT /api/settings`
- Choosing _what_ plays (that's the card) or track-level control — one album, plays through

## 4. Requirements on the environment

These are properties of the **Sonos household**, not the code, and each degrades to a logged
"ignored" rather than an error:

- **Spotify added as a service in the Sonos app** (Settings → Services), on a **Premium** account.
- **At least one Spotify item saved as a Sonos Favorite** — Amp reads it to derive the account's real
  `sid`, `sn`, and `cdudn` token (modern Sonos hides these behind cloud auth; the favorite is the
  authoritative local source — see [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md) and the spike). Any one Spotify favorite unlocks playing
  _any_ album.
- The Amp host, the Sonos speakers, and the workstation share a LAN.

## 5. Recommended tech stack

Mirrors Conductor and Backdrop for consistency.

- **Runtime**: Node.js 20 LTS, TypeScript.
- **Server**: Fastify (+ the shared `X-Trigger-Secret` `onRequest` hook).
- **Sonos**: [`@svrooij/sonos`](https://github.com/svrooij/node-sonos-ts) in-process, wrapped behind a
  thin `SonosDriver` port. Chosen over `node-sonos-http-api` to avoid running a second service; the
  port lets us swap to it if the in-process library breaks on a firmware change.
- **Process management**: systemd unit on the runtime Pi (sibling to Conductor/Backdrop).

## 6. Architecture

```
┌──────────────┐   POST /api/scan    ┌─────────────────────────────┐   UPnP/SOAP   ┌──────────────┐
│   Stylus     │────────────────────>│           Amp               │──────────────>│  Sonos       │
│  (stand)     │  { event, uri, … }  │   (Fastify, headless)       │  (LAN)        │  coordinator │
└──────────────┘                     │                             │               └──────┬───────┘
                                     │  ┌───────────────────────┐  │                      │
    Curator ──HTTP push──► album-    │  │   Playback engine     │  │                 [ Speakers ]
        assets store  ─┐            │  │   - card gate         │  │
                       └───────────>│  │   - idle timeout      │  │
              PUT /api/settings ───>│  │   SonosDriver (port)  │  │
              (target room)         │  └───────────────────────┘  │
                                     └─────────────────────────────┘
```

Three modules, matching Conductor's split:

1. **Sonos Adapter** (`SonosDriver` port + `SvrooijSonosDriver`) — discovers devices, resolves the
   target's group **coordinator** (queue commands must go there — the spike hit UPnP 800 otherwise),
   derives + caches the Spotify binding from a favorite, and builds/enqueues the album container URI
   (`AddURIToQueue` → `SwitchToQueue` → `Play`). Wraps every call in a bounded timeout.
2. **Playback engine** — owns the IDLE⇄PLAYING state for the single target, the card gate, and the
   90-minute idle timeout (injected `Timers`). One album active at a time; a new card swaps.
3. **HTTP API** — `/api/scan` (Stylus), `/api/settings` (Curator), health/admin.

## 7. Data model

```typescript
// Persisted (JSON store, ~/marquee-amp/amp.json — matches Conductor's store.ts pattern)
type Settings = {
  targetRoom: string | null; // Sonos room/group name; null until Curator pushes one
  updatedAt: string;
};

// Runtime (in-memory)
type SpotifyBinding = {
  sid: string; // service id from a favorite, e.g. "12"
  sn: string; // account serial from a favorite, e.g. "1"
  token: string; // cdudn token, e.g. "SA_RINCON3079_X_#Svc3079-0-Token"
  derivedAt: number;
};

type ActivePlayback = {
  curatorId: string;
  spotifyUri: string; // spotify:album:<id>
  target: string; // resolved coordinator name
  startedAt: number; // performance.now()
  idleTimer: NodeJS.Timeout;
};
```

## 8. HTTP API

All JSON. Runs on `http://0.0.0.0:4741` (bound to the LAN so Stylus can reach it; port picked to sit
next to Conductor 4737 and Backdrop 4740).

### Scan events (from Stylus)

| Method | Path        | Body                                                                                 | Behavior                                                                                                                                            |
| ------ | ----------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/scan` | `{ event:"start", uri, tagUid, readerId?, at }` or `{ event:"stop", readerId?, at }` | See §9. Auth via `X-Trigger-Secret`. Always `202` on a well-formed scan; `4xx` only for a malformed body or a non-`curator:(album\|card):<id>` URI. |

### Settings (pushed from Curator)

| Method | Path            | Purpose                                                                                                |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/settings` | Current settings (target room, binding-derived?, Sonos reachable?).                                    |
| PUT    | `/api/settings` | `{ targetRoom }`. Curator pushes the chosen Sonos room/group. Persisted; the default target for scans. |

### Local operations / debugging

| Method | Path               | Purpose                                                                    |
| ------ | ------------------ | -------------------------------------------------------------------------- |
| GET    | `/healthz`         | 200 if the service is up. Not behind auth.                                 |
| GET    | `/api/status`      | State, current album, target, whether the Spotify binding is derived.      |
| GET    | `/api/sonos/rooms` | Discovered Sonos rooms/groups (for Curator to populate the target picker). |
| POST   | `/api/admin/play`  | `{ spotifyUri, targetRoom? }`. Manual override for dev/smoke tests.        |
| POST   | `/api/admin/stop`  | Force to idle.                                                             |

## 9. Scan handling (the exact flow)

Mirrors Conductor's `/api/scan` (ADR 0019), with the kind gate added:

1. `parseScan(body)` → `400` if malformed (reuse the Conductor/Backdrop parser shape).
2. **stop** → `driver.stop(target)`; `202 { action:"stopped" }` (or `{ action:"ignored", reason:"no target" }`).
3. **start** → `parseCuratorUri(scan.uri)`:
   - not `curator:(album|card|demo):<id>` → **`400`** (malformed URI — even when no target configured).
   - `kind === "album"` → **`202 { action:"ignored", reason:"sleeve — vinyl plays" }`.** (The whole
     point: sleeves don't stream.)
   - `kind === "card"` or `"demo"` — identical but for _what_ is handed to Sonos:
     - no target configured → `202 { action:"ignored", reason:"no target" }`.
     - `assets.read(curatorId)` is `null` (not synced) → `202 { reason:"album not synced" }`.
     - **what plays**: `card` → `metadata.spotifyUri`. `demo` → `demoTrack.spotifyUri` if the album
       has a chosen track, **else `metadata.spotifyUri`** — a demo tag with no choice plays the whole
       album exactly as a card does, and logs that it fell back
       ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md) §3: a silent tag is
       indistinguishable from a mis-written one).
     - neither present → `202 { reason:"album not on spotify" }`.
     - Spotify binding not derivable (no favorite / Sonos unreachable) → `202 { reason:"no sonos binding" }`.
     - else `driver.play(target, uri)` → `202 { action:"playing", curatorId, spotifyUri }`, and for a
       demo scan also `demoTrack: <uri> | null` so a caller can tell a real choice from the fallback.

> **What "album not on spotify" meant in practice (2026-08-08, [ADR 0059](../adrs/0059-a-matched-album-plays-only-on-an-exact-match.md)).** Amp was
> correct and still silent for most of a real library: Curator matched Discogs albums to Spotify for
> their cover art and discarded the identity, so `metadata.spotifyUri` was absent on 481 of 499
> records — 393 of which it had actually identified. Curator now keeps the URI on an **exact** match
> (a close match lends its cover and stays unplayable), and a backfill re-matches what was already on
> disk. Nothing in Amp changed: it reads the same field and knows nothing about match confidence,
> which is the point of gating at write time.

**Every "can't act" case is a logged `202`, never an error** — a hardware scan must not error-storm an
always-on service (runtime-overview §9). Only a malformed body/URI is a 4xx.

## 10. Sonos playback details

Distilled from the working spike (`spikes/sonos-spotify/play-album.js`):

- **Coordinator routing.** Queue commands (`AddURIToQueue`, `SwitchToQueue`) must target the group
  **coordinator**, not a member — a grouped/bonded speaker (stereo pair, joined rooms) returns UPnP
  800 otherwise. Resolve `device.Coordinator` (with a `GroupId` fallback when discovery leaves it
  unset).
- **Binding derivation.** Browse `FV:2`, find a Spotify favorite, extract `sid`/`sn` from its
  container `<res>` and the `SA_RINCON<region>…-Token` from its `resMD`. Cache it (`SpotifyBinding`);
  re-derive on cache miss or a play failure. Never hardcode `sid=9`/`sn=7` (the library's defaults —
  wrong for a real account).
- **Enqueue.** Let `@svrooij/sonos` build the container URI + metadata (its serialization is
  UPnP-valid), then patch in the derived `sid`/`sn`; region for the metadata token comes from the
  derived token itself. **The patch must handle both separator spellings**: the library emits an
  album container with bare `&`, but a **track** URI with `&amp;` already escaped
  (`x-sonos-spotify:…?sid=9&amp;flags=8224&amp;sn=7`). Matching only `[?&]` left the hardcoded `sn=7`
  in place on exactly that shape — a UPnP 800 on a live account, and unreachable until demo tags made
  Amp play tracks ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)). Sequence: `RemoveAllTracksFromQueue` → `AddURIToQueue` → `SwitchToQueue` →
  `Play`. (Hand-rolled metadata tripped UPnP 402 in the spike — use the library's.)
- **Bounded everything.** Discovery and each SOAP call get a timeout — Amp is always-on and a hung
  Sonos call must not wedge the event loop (CLAUDE.md "bound your fetch/spawn/loops").

## 11. Target configuration & idle timeout

- **Target room is pushed, not discovered** — Curator's settings UI lets the user pick a Sonos
  room/group and `PUT`s it, same rationale as Conductor's listening room (Curator may be offline at
  scan time). No target → scans degrade to `202 ignored`.
- **Idle timeout (safety net).** If PLAYING and no scan/command arrives in `idle_timeout_minutes`
  (default 90), stop playback. Insurance for a lost `stop` (WiFi drop on sleeve/card removal), not a
  substitute for reliable delivery. Same mechanism (injected `Timers`) as Conductor/Backdrop.

## 12. Config

TOML at `$AMP_CONFIG` / `config.toml`, env fallbacks, `override` for tests — Conductor's `loadConfig`
shape:

| Field                | Source                                            | Default                                    |
| -------------------- | ------------------------------------------------- | ------------------------------------------ |
| `port` / `host`      | `[server]` / `AMP_PORT`                           | `4741` / `0.0.0.0`                         |
| `sharedSecret`       | `[auth].shared_secret` / `TRIGGER_SHARED_SECRET`  | `null` (auth off + boot warning, dev-only) |
| `dataDir`            | `[storage].data_dir` / `MARQUEE_DATA_DIR`         | `~/marquee`                                |
| `albumAssetsDir`     | `[storage].album_assets_dir` / `ALBUM_ASSETS_DIR` | `{dataDir}/album-assets`                   |
| `idleTimeoutMinutes` | `[runtime].idle_timeout_minutes`                  | `90`                                       |
| `defaultTargetRoom`  | `[sonos].target_room` / `AMP_TARGET_ROOM`         | `null` (else set via `PUT /api/settings`)  |

> **`album_assets_dir` must point at Conductor's
> ([ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)).** Curator pushes the store
> to Conductor's ingest API and Amp reads the resulting directory — one push serves both, because
> they are siblings on one Pi (runtime-overview §7). **The default is not that directory**, so an Amp
> left on defaults reads a path nothing writes and every card scan fails to resolve an album. Set it
> explicitly:
>
> ```toml
> [storage]
> album_assets_dir = "/home/pi/marquee-data/album-assets"   # must equal Conductor's
> ```
>
> If Amp ever moves to its own host, this coupling breaks and Amp needs its own ingest route.

## 13. Testing

vitest, `packages/amp/test/*.test.ts`, Fastify `app.inject`, DI seams (`buildServer({ config, store,
driver, timers, assets })`) — Conductor's `test/server.test.ts` is the template.

- **`FakeSonosDriver`** (new — there is no fake Sonos in `packages/fakes`) records `play`/`stop`
  calls, mirroring `makeFakeDriver` for Hue. It lets scan tests assert "card → play called with the
  right `spotify:album:` URI; sleeve → not called" without hardware.
- Scan-intake tests: card start → play; **sleeve start → ignored, driver not called**; stop →
  stop; degrade (no target / not synced / no spotifyUri / no binding); `400` on bad URI; `401`
  without secret; idle-timeout fires stop via `FakeTimers`.
- **Binding-derivation unit test** against the real favorite DIDL captured in the spike (assert
  `sid`/`sn`/token extraction) — this is the fragile, firmware-coupled bit, so it gets a regression
  test.
- A `SonosDriver` **contract test** (the fake and, behind a hardware/opt-in flag, the real driver
  satisfy the same suite), matching Marquee's fake-needs-its-own-tests doctrine.

## 14. Development milestones

Each ends demoable.

1. **Contracts: the `card` kind.** Add `parseCuratorUri` to `@marquee/contracts`, widen the
   scan-event schema `uri` pattern to `^curator:(album|card):[a-z0-9]{8}$`, contract tests for both
   kinds. Success: a `curator:card:…` payload validates; helper returns `{ kind:"card", curatorId }`.
2. **Conductor + Backdrop accept `card`.** Widen their URI parsers to treat `card` as `album`.
   Success: a card scan drives lights and video exactly like a sleeve. (No behavior change for
   `album`.)
3. **Amp scaffold.** Package, Fastify server, config, store, `/healthz`, `X-Trigger-Secret` hook.
   Success: `curl /healthz` → 200; a scan without the secret → 401.
4. **Card gate + asset lookup.** `/api/scan` with a `FakeSonosDriver` and an in-memory asset reader.
   Success: card → driver.play(spotifyUri); sleeve → ignored; degrade paths return 202.
5. **Real Sonos driver.** `SvrooijSonosDriver` — discovery, coordinator routing, favorite-derived
   binding, enqueue. Success (on the LAN): `POST /api/admin/play {spotifyUri}` → audio.
6. **Idle timeout + settings.** Push a target via `PUT /api/settings`; idle timeout stops playback.
   Success: leave it PLAYING, timeout fires, audio stops.
7. **Stylus + systemd.** Stylus forwards `curator:card:` URIs; Amp ships as a systemd unit. Success:
   place a real card → album plays; place a sleeve → silence (vinyl).

## 15. Known gotchas

- **Unofficial UPnP surface.** The container URI format and derived `sid`/`sn`/token can shift with
  Sonos firmware. Keep the `SonosDriver` port thin; `node-sonos-http-api` is the fallback transport.
- **No favorite = no binding.** If the household has zero Spotify favorites, Amp can't derive the
  binding and every card scan degrades to `202 ignored`. Surface this in `/api/status` and the boot
  log so it's obvious, not mysterious.
- **Grouped speakers.** Always resolve the coordinator before queueing (UPnP 800 otherwise).
- **Album not in the account's market** → `AddURIToQueue` can fail; treat as a play error → degrade,
  don't crash.
- **Two audio sources.** If someone scans a card _and_ drops a matching vinyl, Amp and the turntable
  both play. That's a user choice, not a bug — but it's why `album` (sleeve) scans deliberately never
  stream.

## 16. What this closes

With Amp, a **card** scan completes the fan-out: Conductor lights the room, Backdrop plays the
visualizer, and Amp streams the album over Sonos — the full immersive experience for records you
don't own on vinyl. A **sleeve** scan is unchanged: lights + video, and you drop the needle. Same
scan event, same album-assets store as the source of truth; the `curator:<kind>:<id>` URI is the only
new shared fact, and only Amp acts on the difference.
