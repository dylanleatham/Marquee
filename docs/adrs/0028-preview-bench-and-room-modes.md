# ADR 0028 — Preview has bench and room modes; driving hardware requires explicit arming

Status: accepted · Date: 2026-07-25 · Extends: [ADR 0007](0007-demo-room-drives-conductor-via-curator-proxy.md)
(Demo Room), [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) (Amp) · Amends: curator-spec §8
(`simulate-scan`), §10 (Preview, Demo Room)

## Context

Curator grew two overlapping preview concepts:

- **`PreviewSection`** — inline on the album detail, gated to `awaiting_preview`, showing the video
  beside the animating palette with approve / reject.
- **The Demo Room** ([ADR 0007](0007-demo-room-drives-conductor-via-curator-proxy.md)) — a
  full-viewport screen that plays the visualizer with Backdrop-accurate transitions while driving the
  **real Hue lights** through Conductor, with place / lift / swap controls and a room picker.

The second is strictly richer, and the desired preview is richer still: the sleeve art shown as it
sits on the stand, the video loop, the lights, and a track from the album playing — the whole
composition, judged together.

But there are two genuinely different situations, and they are not stylistic preferences:

1. **Preparing albums for later, while not in the listening room.** The whole point is that nothing
   happens in the room — you are getting albums ready to be available when you get home.
2. **Preparing albums while other people are in the listening room.** Taking over their lights and
   starting music is a side effect on other humans, not a rendering choice.
3. **A dress rehearsal before writing stickers.** Here driving the real hardware is exactly the
   point — assembling everything and confirming it works before committing to a physical tag.

Today `▶ Demo Room` sits one click from the album detail and will change the lights in an occupied
room with no warning, and there is no preview path that is guaranteed not to.

## Decision

**Preview is one workstation with two modes**, and hardware is opt-in per working session.

### Bench preview — the default

Everything rendered in the window; **touches no hardware, ever**. Sleeve art, the video loop with
Backdrop-accurate crossfade timing, the palette animating as CSS under the runtime pattern, and audio
at the workstation. Always available, cannot surprise anyone.

### Room rehearsal — armed

The real runtime path minus the physical tag: lights → Conductor, video → Backdrop, audio → Amp.
`POST /api/albums/:curatorId/simulate-scan` already fans out to the first two; **Amp becomes its
third target**, making that endpoint the complete rehearsal rather than two-thirds of one.

Audio follows ADR 0007's proxy pattern exactly — `POST /api/demo/audio` → Amp's
`POST /api/admin/play` — so the browser never holds the shared secret and no new auth surface is
introduced.

The **Demo Room is the full-viewport presentation of this mode**, not a separate feature. Its
place / lift / swap controls and room picker are unchanged.

### Arming

A **room-arm switch in the persistent bottom status bar**, beside the Roadie strip. Two states,
persisted across launches, defaulting to bench:

- **Bench only** (default) — every hardware-touching control is disabled with the reason shown: room
  rehearsal, Demo Room, verify-physical.
- **Room live** — armed; the status bar says so continuously while it is on.

## Consequences

- **The safe path is the default path.** Clicking Preview can never change someone's lights. Driving
  hardware requires a deliberate act that stays visible while in effect.
- **`simulate-scan` gains Amp as a third fan-out target**, and stops being a button under
  verification. It was always a rehearsal filed in the wrong place; Ship keeps only genuinely
  physical actions (payload, QR, `.nfc`, mark written, verify).
- **`PreviewSection` and the Demo Room converge** into one workstation with two modes, removing a
  duplicated concept.
- **Cheap to build.** Every part exists: Conductor and Backdrop fan-out in `simulate-scan`, the
  proxy pattern in ADR 0007, and Amp's `/api/admin/play` — specced as a manual override for dev and
  smoke tests (amp-spec §Admin), which is precisely what a rehearsal is.
- **The arm switch is app-wide, not preview-local**, because verify-physical also drives the room.
  One switch at the start of a session beats a decision at every button.
- **Bench audio is unresolved and does not block this.** The route (Web Playback SDK / `preview_url`
  / Connect transfer) needs a spike — see [curator-ui-ux.md](../specs/curator-ui-ux.md) §11. Bench
  preview ships silent; sleeve + video + palette carries most of the judgment. Room rehearsal's audio
  has no such uncertainty: it goes through Amp, which already works.
- **[ADR 0034](0034-amp-sonos-playback-and-card-uri.md)'s rejection of Spotify Connect does not transfer** to bench audio. It was rejected for
  Amp because Connect cannot wake an idle Sonos speaker; a workstation Spotify client is already
  awake. The spike must still confirm the licensing and packaging constraints.
