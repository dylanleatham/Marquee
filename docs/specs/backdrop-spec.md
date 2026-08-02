# Backdrop — Video Player Technical Spec

_The visual companion to the record spinning — it's the backdrop, not the show._

> **Implementation status (2026-07-20).** The workstation-testable core is built in
> `packages/backdrop` (milestones 2–9): config, `library.json` store, the IDLE⇄PLAYING controller
> with the idle-timeout safety net, the WebSocket hub, the full §8 HTTP API, and the vanilla kiosk
> SPA. 112 tests; verified live in a browser (WS connect, `/healthz` gating, scan→play→idle, the
> `show-message` path). The kiosk SPA itself gained its first tests in
> [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md) — driven by shadowing
> `document`/`location`/`WebSocket`, which covers playback ordering and state but not rendering (see
> §"Playwright vs jsdom" in [testing-strategy](testing-strategy.md) for the browser tests still owed). Milestones 1/10/11 (kiosk launcher, systemd, real NFC) are hardware and are
> documented as a step-by-step runbook in
> [packages/backdrop/DEPLOY.md](../../packages/backdrop/DEPLOY.md), not yet automated.
>
> **One correction to this spec:** §6 says launch the kiosk with `--app=http://localhost:4740`. A
> page served over `http://` **cannot** load the local `file://` video clips (Chromium blocks
> cross-scheme), so the launcher must instead point Chromium at the SPA as a **`file://` origin**
> (or keep `http://localhost` and add `--allow-file-access-from-files`). The WebSocket connects back
> to `ws://localhost:4740/ws` regardless. See the README "Deploy on the Pi" section. Also added
> beyond the spec: resolved `filePath`s must sit under `media_dir` (defense-in-depth against a
> poisoned library) — an unknown URI, a missing file, or an out-of-tree path all degrade to the
> §9/§10 "stay put + quiet corner hint" behavior rather than playing.

## 1. Purpose

A Pi attached to a display (TV or monitor near the listening area) that plays looping visualizer videos in response to NFC scan events. When a tagged sleeve is placed on the stand, Backdrop starts the corresponding album's visualizer; when removed, it fades back to an idle state.

Videos live on the Pi's local SD card. Backdrop doesn't know or care where they came from — Curator's job is to make sure they're there and to keep the album-to-video mapping in sync.

## 2. Success criteria

**Scan a tagged sleeve → correct visualizer starts on the display within 1 second, loops smoothly, feels intentional. Scan a different sleeve → smooth crossfade to the new video. Remove sleeve → fade to idle within 2 seconds. Do it repeatedly for an evening without a crash, a stutter, or a jarring flash of white.**

The "feels intentional" part is doing a lot of work in that sentence. Loading spinners, black flashes, WebSocket disconnect banners, and codec errors all torpedo the illusion. Half the work in this spec is preventing those.

## 3. Scope

### In scope

- HTTP endpoint that accepts scan events matching the NFC trigger service's outbound shape
- URI → video file lookup via a local library file
- Chromium kiosk playback with clean crossfade transitions
- Idle state (subtle, non-distracting)
- Idle timeout safety net (recovers gracefully from lost `stop` events)
- Library sync mechanism to pull updates from Curator
- Audio muted by default (record is the audio)
- systemd auto-start, Chromium auto-launch

### Out of scope

- Video generation or transcoding (external AI service does the generation, Curator validates)
- Multi-display support (single display)
- WebGL / procedural visualizers (nice to have later; MP4 loop is fine for now)
- Real-time audio-reactive effects (would need audio input from turntable)
- Album-side detection or track-level video changes
- CEC (turning TV on/off automatically) — the display just stays on

## 4. Hardware BOM

| Item                                          | Purpose                                              | Cost          |
| --------------------------------------------- | ---------------------------------------------------- | ------------- |
| Raspberry Pi 5 (4GB or 8GB)                   | Main compute, HDMI output, **software** H.264 decode | ~$60-80       |
| Pi 5 official power supply (27W USB-C)        | Stable power under video load                        | ~$12          |
| Micro HDMI to HDMI cable                      | Display connection                                   | ~$5           |
| High-endurance microSD card (128GB, A2 rated) | OS + videos + assets                                 | ~$20-25       |
| Active cooling case (fan or heatsink)         | Pi 5 gets warm decoding video                        | ~$10-15       |
| **Total**                                     |                                                      | **~$110-140** |

**Why Pi 5 over Pi 4:** Meaningful CPU improvements, which is what actually carries video playback here — see the decode correction immediately below.

> ### ⚠️ Correction (2026-07-29, [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md), [issue #180](https://github.com/dylanleatham/Marquee/issues/180))
>
> **This section used to claim "Hardware-accelerated H.264 decode with headroom to spare" as the reason to pick a Pi 5. That is wrong, and it was wrong from the day it was written.**
>
> The Pi 5's VideoCore VII **dropped** the Pi 4's H.264 decode block and kept only an HEVC decoder. Every H.264 frame Backdrop plays is decoded **on the CPU**, inside Chromium, while that same CPU composites the page. For this codec the Pi 5 is the _worse_ of the two boards — the A76 cores are what make it work at all, not a video block.
>
> The error propagated. `ALLOWED_CODECS` in Curator was commented "H.265 for Pi 5"; DEPLOY.md told operators to re-encode HEVC **into** H.264 — converting the one codec this board has silicon for into the one it doesn't. And because nothing bounded what a visualizer could be, ~20 Mbps 1080p30 files with dead AAC tracks reached the display and flickered and stuttered continuously, while playing perfectly in Curator's preview (a workstation, with a hardware decoder, that doesn't care).
>
> **What changed:** Curator now enforces a **decode budget** on ingest — ≤1080p30, ≤10 Mbps, H.264, no audio — and encodes anything outside it down to 8 Mbps. See [curator-spec §9](curator-spec.md) for the mechanism. §6 and §13 below are corrected to match.
>
> **Still open, deliberately:** whether Chromium on Pi OS will use the Pi 5's HEVC hardware decoder for a `file://` `<video>`. If it does, that inverts the codec policy and is the one real step change available here. It is an experiment, not an assumption, so the pipeline stays on H.264 until someone runs it.

**Why "high-endurance" microSD:** Regular microSD cards wear out under repeated writes, and while you're mostly reading, occasional writes (logs, library sync) add up over a year of always-on operation. High-endurance cards are rated for the video-surveillance duty cycle and are only marginally more expensive. A2 rating gives you better random-read performance which helps Chromium.

**Storage sizing:** 500 albums × ~100MB average visualizer = 50GB. Plus OS and headroom, 128GB is comfortable. Go 256GB if you're being generous, don't overpay for 512GB.

**Display:** Whatever's convenient. HDMI is HDMI. **1080p is the ceiling, not the baseline** — this line used to say "4K works on Pi 5 for H.264 content," which the §4 correction above contradicts: H.264 decode is software here, and Curator's decode budget caps ingest at 1080p30 and downscales anything larger ([ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md)). A 4K _panel_ is fine, but **the mode must be forced to 1920x1080 at 60Hz** — this is the single highest-impact setting in the whole system, and it is not optional.

> ### ⚠️ Measured (2026-08-02, [ADR 0047](../adrs/0047-the-kiosk-display-pipeline-not-the-decoder.md), [issue #211](https://github.com/dylanleatham/Marquee/issues/211))
>
> The paragraph above used to end "…which costs more than the decode" — correct, but written as a thing to go check, with no number, buried in a bill of materials. It went unheeded for a month while two ADRs' worth of work was aimed at the decoder instead.
>
> On the real stand, with every visualizer already inside the decode budget, the panel sat at its EDID default of **3840x2160@30** and the display dropped **5.5% of frames sustained** — while the SoC was un-throttled at 56 °C and Chromium used ~45% of four cores. Forcing **1920x1080@60**, same file, took it to **0%**.
>
> Two independent defects share that one mode line. **4K** makes Chromium render the page at 3840x2160 and rescale every frame. **30Hz** gives a 30fps clip exactly one scanout slot per frame, so anything slightly late is simply lost — at 60Hz a late frame just repeats. The refresh-rate half was in no document at all and is the larger of the two.
>
> `packages/backdrop/deploy/kiosk.sh` now sets the mode on every launch (`xrandr` at runtime does not survive a reboot), and `test/deploy-assets.test.ts` fails if that line is ever dropped.

## 5. Where it fits

```
                                      ┌──────────────────┐
                                      │  Stylus     │
                                      │  Service         │
                                      └────────┬─────────┘
                                               │  HTTP POST
                                               │  { event, uri, tagUid }
                                               ▼
    ┌─────────────────────────────────────────────────────────┐
    │                    Backdrop (Pi 5)                       │
    │                                                          │
    │  ┌─────────────────┐          ┌──────────────────────┐  │
    │  │  Node.js server │◄────────►│  Chromium (kiosk)    │  │
    │  │                 │  WebSocket│  file:// SPA         │  │
    │  │  - /api/scan    │          │  - HTML5 <video>     │  │
    │  │  - library      │          │  - CSS transitions   │  │
    │  │  - state mgmt   │          │  - idle overlay      │  │
    │  └────────┬────────┘          └──────────┬───────────┘  │
    │           │                              │              │
    │           │  reads                       │  file:// URL │
    │           ▼                              ▼              │
    │  ┌──────────────────┐         ┌────────────────────┐   │
    │  │  library.json    │         │  /media/           │   │
    │  │  (URI → file)    │         │    visualizers/    │   │
    │  └──────────────────┘         │      *.mp4         │   │
    │                                └────────────────────┘   │
    │                                                          │
    └────────────────────────────┬─────────────────────────────┘
                                 │  HDMI
                                 ▼
                              [ Display ]

           ┌──────────────────────┐
           │   Curator (elsewhere │  ──── periodic sync ────►  library.json + videos
           │   on the LAN)        │
           └──────────────────────┘
```

The Node backend and Chromium both run on the same Pi. Chromium loads a local SPA (via `file://` or `http://localhost`); the backend pushes commands over WebSocket. Videos are served straight from the local filesystem — no HTTP hop, no network transfer.

## 6. Software stack

- **OS**: Raspberry Pi OS Bookworm (64-bit, Desktop edition)
- **Backend runtime**: Node.js 20 LTS + TypeScript. Same as Conductor and Curator — worth the consistency even though Python would work.
- **Backend framework**: Fastify + `@fastify/websocket`.
- **Frontend**: Vanilla HTML/CSS/JS. Genuinely doesn't need a framework — one video element, one overlay, one WebSocket connection. Vanilla is lighter and easier to debug in a kiosk context.
- **Browser**: Chromium (from apt), launched via `chromium-browser --kiosk --app=http://localhost:4740`.
- **Process management**: systemd — one unit for the Node backend, one for the browser launcher.
- **Video codecs**: H.264 in MP4. Chromium supports this natively; no additional codec install needed. **Decoded in software on a Pi 5** (§4 correction), so the clips are held to a decode budget by Curator on ingest — ≤1080p30, ≤10 Mbps, no audio track ([ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md)).

## 7. Playback state machine

Backend maintains a single global state, communicated to the browser over WebSocket.

```
                 ┌────────────────┐
                 │      IDLE      │  showing: idle overlay
                 └───────┬────────┘
                         │  scan event: start(uri)
                         │  → resolve uri → filePath
                         │  → send PLAY command to browser
                         ▼
                 ┌────────────────┐
                 │    PLAYING     │  showing: video, looped
                 └───────┬────────┘
                         │
             ┌───────────┼───────────┐
             │           │           │
             │           │           │
   scan: stop │  scan: start(new uri) │  idle timeout fired
             │           │           │
             ▼           ▼           ▼
        fade to     crossfade to    fade to
        IDLE        new video       IDLE
```

**Transitions**, all CSS-driven for smoothness:

- **IDLE → PLAYING**: idle overlay fades out (400ms), video fades in (400ms). Total ~800ms perceived, well under the 1s validation target.
- **PLAYING → PLAYING** (swap): current video fades out (400ms) while new video preloads underneath, then fades in (400ms). If preload isn't ready by fade-out end, hold a beat. The backend commits to the new URI before the fade completes, so a rapid third scan cancels cleanly.
- **PLAYING → IDLE**: video fades out (600ms), idle overlay fades in (400ms). Once the fade has
  finished, **both** layers are paused and released — an idle kiosk holds no video resource at all
  ([ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)).

> ### Correction (2026-08-02, [ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md), [issue #211](https://github.com/dylanleatham/Marquee/issues/211))
>
> **The swap above only worked for commands that arrived cleanly separated.** The SPA's two video
> layers used to swap roles on the same 450ms timer that tore down the outgoing element, so for the
> whole length of a crossfade the "free to load into" layer was the one on screen. Every command the
> hardware sends lands in that window: a mid-crossfade swap loaded over the picture and then stripped
> the `src` off the playing video (black screen); a repeat scan restarted the clip from zero; a stop
> during a load left a frozen frame with the idle overlay hidden; and because Stylus publishes
> `stop`-then-`start` for a SWAP with "No IDLE in between" (stylus-spec §7), **every sleeve swap
> flashed the idle gradient** — which §2 rules out by name.
>
> The roles now swap synchronously the moment a clip is put on screen, and cancelling a stop restores
> the clip it was fading out, so a swap crossfades as described above.

**Idle timeout**: if the current state is PLAYING and no scan event has arrived in `idle_timeout_minutes` (default 90), transition to IDLE. This is the safety net for the "lost `stop` event" case flagged in the Stylus spec — Backdrop never gets stuck showing Purple Rain overnight because a WiFi drop ate the removal event.

**Cursor**: hide the cursor immediately on load and never show it. Chromium kiosk flag `--kiosk` does most of this; belt-and-braces with `cursor: none` on the body.

## 8. HTTP API

Runs on `http://localhost:4740` (bound to all interfaces so the NFC service can reach it from another Pi on the LAN).

### From the NFC trigger service

| Method | Path        | Purpose                                                                                                                                                |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/scan` | Body: `{ event: "start" \| "stop", uri?, tagUid?, at }`. Matches the NFC trigger service's outbound shape exactly. Auth via `X-Trigger-Secret` header. |

Response is 202 (accepted) — Backdrop doesn't block the trigger while it does work. If the URI has no matching video, Backdrop logs a warning and stays idle (with a subtle "not in library" indicator in the corner; see §10).

### From Curator (for library sync)

| Method | Path                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/library/sync`   | Body: `{ entries: [{ uri, filePath, durationSec, contentHash }] }`. Full replace of the library map.                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/api/library/update` | Body: `{ uri, filePath?, durationSec?, contentHash? }`. Single-entry upsert.                                                                                                                                                                                                                                                                                                                                                                                               |
| DELETE | `/api/library/:uri`   | Remove one entry. Does not delete the video file.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/api/library`        | Read current library map. Each entry carries a derived **`fileMissing: boolean`** alongside its stored fields — whether the `filePath` would actually be playable right now (present on disk **and** under `media_dir`, the same judgement `play()` enforces). The entry and the bytes move on separate legs ([ADR 0038](../adrs/0038-curator-pushes-media-over-http.md)), so listed-but-unplayable is a real intermediate state, and was previously invisible to Curator. |
| PUT    | `/api/media/:fileId`  | Upload a visualizer. Body streams to `{media_dir}/{fileId}.mp4`. `201 { fileId, bytes }`.                                                                                                                                                                                                                                                                                                                                                                                  |

Curator can fire off metadata and media in either order; Backdrop is tolerant of library entries
pointing at files not yet present (§10 covers the UX).

> **Backdrop accepts the video file itself as of 2026-07-29** ([ADR 0038](../adrs/0038-curator-pushes-media-over-http.md)).
> This section previously said video files "get synced separately (rsync, syncthing, whatever)" and
> that Backdrop was "only in charge of the metadata mapping". That remains a supported deployment —
> Curator's `media_transfer = "none"` — but it is no longer the only one, because the gap was silent:
> an album could be prepared, synced, and reported healthy with no video on the Pi at all.
>
> `PUT /api/media/:fileId` is the only route that writes to Backdrop's disk from the network, so:
>
> - **`fileId` must match `^[a-z0-9]{8}$`** — it becomes a filename in the directory Backdrop serves
>   videos from, so it is rejected outright, never sanitised.
> - **The body streams and is capped** by `[storage].max_upload_mb` (default 2048, env
>   `BACKDROP_MAX_UPLOAD_MB`) → `413`.
> - **The upload is bounded by inactivity**, not a deadline: `[runtime].upload_stall_ms` (default
>   60000, env `BACKDROP_UPLOAD_STALL_MS`) → `408`. A real visualizer over a poor link is
>   legitimately slow, so only "bytes stopped arriving" separates slow from dead. Without it a client
>   that vanishes without closing its socket parks the read loop forever, holding a file descriptor
>   and a temp file.
> - **Temp file, renamed into place only on a clean finish**, with a name unique per request so two
>   concurrent uploads of the same album cannot interleave. A half-written mp4 that _looks_ whole is
>   worse than a missing one — Backdrop would play it.
> - **A write failure fails the request, not the process.** A full SD card raises an `error` on the
>   write stream; unhandled, that would take down all of Backdrop rather than one upload.

### For local operations and debugging

| Method | Path                       | Purpose                                                                                                                         |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/status`              | Current state, currently-playing URI, uptime, browser connection status, and `playbackQuality` (below).                         |
| GET    | `/healthz`                 | 200 if backend is up and browser is connected.                                                                                  |
| POST   | `/api/admin/play`          | Body: `{ uri }`. Manual override, useful during dev.                                                                            |
| POST   | `/api/admin/stop`          | Force to idle.                                                                                                                  |
| POST   | `/api/admin/simulate-scan` | Body: same as `/api/scan`. Exists for parity with the trigger service's simulate endpoint — makes end-to-end testing symmetric. |

> **`playbackQuality` — how the board actually decoded** (2026-08-02,
> [ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)).
> [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md) set a decode budget with nothing
> watching the result — Curator's preview runs on a workstation and cannot see the defect, so the only
> report of a glitch was a person in front of the display. The kiosk now samples
> `getVideoPlaybackQuality()` every 10s and Backdrop serves the verdict:
>
> ```json
> {
>   "filePath": "/…/visualizers/a1b2c3d4.mp4",
>   "totalFrames": 1800,
>   "droppedFrames": 90,
>   "droppedPct": 5,
>   "degraded": true,
>   "at": "2026-08-02T19:04:11.221Z"
> }
> ```
>
> `null` while idle, and `null` until the kiosk has reported on the file that is _currently_ on screen
> — a verdict left over from the previous album would be worse than none. `degraded` is sustained loss
> over **2%**, about one visible hitch per second at 30 fps; a clip crossing it logs one warning to
> journald, not one per sample. Samples under 30 frames are recorded but never judged.

## 9. Library structure

`~/backdrop/library.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-07-06T14:12:00Z",
  "entries": {
    "curator:album:2k7bxq9m": {
      "filePath": "/home/pi/backdrop/media/visualizers/2k7bxq9m.mp4",
      "durationSec": 187,
      "contentHash": "sha256:abc123..."
    },
    "curator:album:...": { ... }
  }
}
```

Notes:

- Absolute file paths. Backdrop doesn't need to guess.
- `contentHash` lets Curator's sync logic know when a video has been updated and needs re-pushing.
- `durationSec` is currently just informational, but useful later if you want to align pattern transitions to loop boundaries or show a progress indicator during dev.
- If the file at `filePath` is missing when a scan comes in, Backdrop logs "video missing," stays in current state, and displays a small "video not synced yet" indicator (see §10). Doesn't crash, doesn't blackscreen.

## 10. Frontend SPA structure

Bare bones — one HTML file, one CSS file, ~200 lines of JS.

**Layout**: full-screen video element with a full-screen overlay stacked on top.

**Video element**:

```html
<video id="player" muted loop playsinline preload="auto"></video>
```

Two video elements actually — `<video id="a">` and `<video id="b">` — for crossfades. One is
`showing`, the other is `spare`; **the roles swap the moment a clip is put on screen, never on a
timer** ([ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)).
A timer-based swap left `spare` pointing at the element being watched for the length of every fade,
and every command the hardware sends arrives inside that window — see the §7 correction.

**Idle overlay**: default is a black background with a very subtle animated gradient (slowly shifting between two near-black shades). Just enough to prove the display isn't dead. When appropriate (see §11), replaces or augments this.

**Status indicators** (small, corner of screen, dev-only or toggleable):

- Bottom-right corner: WebSocket connection indicator — a labelled pill (`ws online` / `ws
connecting…` / `ws offline`), colour-coded as a redundant cue so it's readable without colour vision
- Bottom-left corner: current URI (small text, low opacity)
- Center-bottom (only on error): "video not in library" or "video file missing" when a scan comes in for something Backdrop can't play

Show or hide the indicators via a `?debug=1` URL param. Off in the demo mode.

**WebSocket contract** (backend → frontend):

```typescript
type Command =
  | { type: "play"; filePath: string }
  | { type: "stop" }
  | { type: "show-message"; text: string; durationMs?: number }
  | { type: "reload" }; // used for hot-reload during dev
```

Frontend responds with events for observability:

```typescript
type Event =
  | { type: "playback-started"; filePath: string }
  | { type: "playback-error"; filePath: string; error: string }
  | { type: "loop-completed"; filePath: string; iteration: number }
  // Cumulative decoder counters for the clip on screen, sampled every 10s while playing and nothing
  // while idle. Backed by `getVideoPlaybackQuality()`; surfaced as `/api/status.playbackQuality`
  // (ADR 0046). Not a cross-service contract — the browser is the same box as the backend — so it
  // lives in packages/backdrop/src/types.ts, like the rest of this channel.
  | {
      type: "playback-quality";
      filePath: string;
      totalFrames: number;
      droppedFrames: number;
    };
```

## 11. Idle behavior

Default: near-black slowly shifting gradient. Simple, non-distracting, no burn-in risk on OLED displays.

A few refinements worth considering, in rough order of "nice for the demo":

1. **Show last-played album art**, faded to ~10% opacity, subtly panning ("Ken Burns" style). Instant "this is a system, not just a screen" signal for guests.
2. **Ambient clock**. Big and low-contrast, in a font that matches your aesthetic. Bonus utility.
3. **Waiting-for-scan hint**. A very faint "place a record" prompt that fades in only after a few minutes of idle — helps first-time guests figure out what's happening.

Ship the gradient as the default. The SPA is structured so the idle overlay is its own component, swappable to any of the above alternatives without touching the playback logic.

## 12. Development milestones

1. **Kiosk mode Chromium.** Fresh Pi 5, Chromium boots into kiosk on a hardcoded local HTML file. Success: TV shows a blank page with a "hello backdrop" message, no browser chrome visible.
2. **Node backend + WebSocket.** Fastify server, WebSocket endpoint, frontend connects, backend sends "hello" over the socket. Success: page shows "hello from backend."
3. **Hardcoded playback.** Drop a test video into `/media/visualizers/`, backend command plays it, frontend loops it. Success: video plays fullscreen, loops seamlessly, no black flash at loop point.
4. **Crossfade transitions.** Two videos, backend command swaps between them. Success: swap looks intentional, no flash, no audio pop (there won't be — mute is default).
5. **`/api/scan` endpoint.** Wire the endpoint, add a library file with a couple hardcoded entries, resolve URI → filePath. Success: `curl` a scan payload, see the video play.
6. **Idle overlay + fade transitions.** Backend sends `stop`, frontend fades to gradient. Success: full state machine passes visual inspection for start / stop / swap.
7. **Idle timeout.** Backend fires stop after N minutes without events. Success: leave PLAYING state on, wait, see it fade to idle.
8. **Library sync API.** Curator can push updates. Success: sync a new entry from Curator, next scan finds the video.
9. **Missing-file handling.** Library entry points at a nonexistent file. Success: scan doesn't crash, shows "not synced" hint, stays in current state.
10. **systemd auto-start.** Backend and Chromium both boot cleanly on power-up. Success: pull the plug, plug it back in, see it come up ready.
11. **NFC integration test.** With the NFC trigger service running, place a real tagged sleeve. Success: video plays. Remove sleeve, video fades out. This is the moment.

## 13. Known gotchas

- **Decode headroom is the scarce resource, not bandwidth or storage.** Because H.264 decode is software on a Pi 5 (§4 correction), anything else the CPU does during playback competes with it directly. Three real instances, all fixed in [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md): the idle overlay's `background-position` animation is not compositor-accelerated, so it repainted the full screen every frame — and kept doing it _underneath a playing video_, because the layer was only dropped to `opacity: 0` and left in the compositing path (it is now parked and `visibility: hidden` while playing); a crossfade left the outgoing video decoding for the whole 450ms fade, running two software decodes at the moment a new clip was also starting (it is now paused when the fade starts); and `stop` acted on `active` while the role swap sat behind a 450ms timer, so a removal landing mid-crossfade left the just-started video playing forever behind the idle overlay, invisible and still decoding (`stop` now acts on both layers). **What did _not_ work: GPU flags.** ADR 0040 also had the launcher pass `--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy`, on the reasoning that compositing the CPU doesn't do is headroom the software decoder gets back. That reasoning was never measured, the Pi's vc4/V3D driver is on Chromium's blocklist for reasons, and overriding it booted the kiosk to a solid black screen. They are removed; DEPLOY.md step 11b now warns against re-adding them. The decode budget is where the win actually came from. When diagnosing "the video looks rough," **read `/api/status.playbackQuality` first** — the kiosk reports its own dropped-frame rate as of [ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md), so this question has a number behind it instead of an opinion. If it says the board is keeping up, the roughness is not decode: check `vcgencmd get_throttled` and the panel's actual mode, since a 4K panel makes Chromium render the page at 3840x2160 and rescale every frame, which costs more than the decode.
- **Most of it was never decode at all.** [ADR 0047](../adrs/0047-the-kiosk-display-pipeline-not-the-decoder.md) settled this with the ADR 0046 signal on its first real run: with every visualizer inside the decode budget and the SoC un-throttled at 45% CPU, the display was still dropping **5.5% of frames** — because the panel was at 3840x2160@30. At 1920x1080@60 it drops **none**. Then, with playback smooth, a **stationary horizontal line a third of the way down** became visible on every clip: `xcompmgr`, the compositor Pi OS autostarts, does no vsync, so Chromium page-flips mid-scanout — and a 30fps clip on a 60Hz panel holds a fixed phase, so the tear parks at one height instead of drifting and reads as a scan line rather than as tearing. Both fixes are checked in (`packages/backdrop/deploy/`) and guarded by `test/deploy-assets.test.ts`, because both are invisible failures: nothing in a build, a type-check, or a runtime assertion notices either, and the second one is invisible to `playbackQuality` too — **a torn picture reports 0% dropped**, since no frame was ever late. When the video "looks bad", the discriminator is whether frames go _missing_ or a frame is _split_.
- **Not every glitch was decode.** ADR 0040 read all of them as throughput, and the third fix above — `stop` acting on both layers — treated a symptom of a deeper defect it left in place: **the role swap itself sat behind that 450ms timer**, so `inactive` pointed at the on-screen element for the length of every fade. Commands that overlap a crossfade are the only kind the hardware sends, and each of them was handed the video being watched. [ADR 0046](../adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md) moves the swap onto the moment a clip goes on screen; see the §7 correction for the four symptoms. The general lesson: a transition bug and a throughput bug look identical from the sofa, which is why the SPA's tests now drive overlapping commands and the Pi now reports its own decode.
- **Chromium autoplay policy.** Chromium blocks autoplay of videos with audio _unless muted or after a user gesture_. Since Backdrop videos are always muted, this shouldn't bite — but if you want to unmute someday, you'll need to launch Chromium with `--autoplay-policy=no-user-gesture-required`. Bake this into the launcher unit now so future-you doesn't have to remember.
- **Seamless looping.** MP4 loop transitions in HTML5 sometimes show a one-frame black flash. If it's noticeable, options are: encode videos with H.264 in fragmented MP4, or use two video elements alternating (play A, when A hits 200ms from end fade to B, restart A when B ends, etc.). Default approach: single-element loop first; only escalate if it looks bad.
- **microSD wear over time.** Even with high-endurance cards, keep the write volume low. Log to journald with a max size, not to a flat file that grows forever. Consider mounting `/tmp` as tmpfs.
- **Screen sleep / DPMS.** Raspberry Pi OS may put the display to sleep after idle. Disable via `xset s off -dpms` in the session, or set it in the display config. Otherwise the TV goes black after 10 minutes and it looks like Backdrop crashed.
- **HDMI handshake weirdness.** Some TVs renegotiate HDMI on wake from sleep and Chromium sometimes doesn't reposition its window correctly. If you see this, `--start-fullscreen` combined with `--window-position=0,0` on the Chromium launcher is the fix.
- **Font rendering in kiosk.** If you go with the ambient clock or album title on the idle screen, install a system font that matches your aesthetic. Default fonts on Pi OS are fine but generic.
- **The "video not in library" scan is going to happen more than you think.** You'll write tags before you generate videos, or you'll test with a random NTAG lying around. The graceful-degradation path (stay in current state, quiet indicator) matters more than it seems.
- **Time sync.** Idle timeout is time-based; if the Pi's clock is way off, timeout doesn't behave. `systemd-timesyncd` is on by default in Pi OS — verify it's working.
- **Chromium updates changing kiosk behavior.** Rare but happens. Pin the Chromium package version; if kiosk mode breaks after an unattended apt-upgrade, that's the likely cause.

## 14. Open questions

- **Should Backdrop own the "which album is currently playing" concept, or should something else?** Right now Backdrop and Conductor each maintain their own "playing state" independently, both driven by the same scan events. Works fine. Alternative: a small orchestrator service holds the canonical state and drives Backdrop and Conductor as clients. Cleaner in theory, more moving parts in practice. Current design: independent state.
- **Preload strategy.** Currently, videos load on demand at scan time (~100-300ms from local SD, imperceptible). If you ever add many-second-long HD videos, or want zero perceived latency, preload the "most likely next" video based on recent play history. Not worth it yet.
- **What if the display isn't connected on boot?** Chromium won't have a display to attach to. Systemd unit should probably `After=graphical.target` and wait for the display. Or gracefully retry.
- **Second display (kitchen? office?)**. Same architecture, second Pi, subscribe to the same trigger events. NFC trigger's payload already has room for a `readerId` — needs a symmetric `displayId` if this becomes a concern. Not now.
- **Interactive controls on the display.** Long-term possibility: point a remote at the TV, browse the collection, force a specific video. Not planned; probably belongs in a phone UI reaching Curator anyway.

## 15. What this closes

With Backdrop implemented, the full runtime loop exists end-to-end:

```
you place a sleeve
    → Stylus reads the tag, POSTs to Conductor + Backdrop
    → Conductor loads palette, drives Hue lights
    → Backdrop loads video, drives the display
    → you drop the needle
    → the room becomes the record

you lift the sleeve
    → Stylus detects removal, POSTs stop
    → Conductor restores light state
    → Backdrop fades to idle
```

Every service in this chain has a single clear job and no visibility into the others' internals. The album-assets store (via Curator) is the shared source of truth. The scan event is the shared runtime signal. Everything else is one component's private problem.
