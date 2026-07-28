# ADR 0037 — Bench preview gets desk audio by transferring Spotify Connect to the workstation client

Status: accepted · Date: 2026-07-27 · Amends: curator-ui-ux.md (§6.1 — bench audio is specified
rather than pending; §11 — the open question is closed and removed) · Proven by:
[`spikes/desk-audio`](../../spikes/desk-audio) · Resolves:
[#93](https://github.com/dylanleatham/Marquee/issues/93)

## Context

Bench preview composes the whole album at the desk — sleeve, palette, video, **and a track from the
album playing at the workstation** (curator-ui-ux §6.1). Everything except the audio shipped in
[#92](https://github.com/dylanleatham/Marquee/issues/92); bench preview says on screen that it is
silent rather than hiding the gap. The route was the one genuinely open question in the desktop UX
(§11), because all three candidates cost something and one of them changes how the app is packaged.

The spike under `spikes/desk-audio` measured all three against real credentials on the target
platform (Windows 11, Spotify Premium, Electron 33.4.11, 2026-07-27) rather than against the docs:

- **30-second `preview_url` clips** — would have been the cheapest by far: an `<audio>` tag, no DRM,
  no Premium, no external process. **The field is empty for this app.** `0/14` album tracks carry it,
  the full track object returns `null`, and `0/5` search hits carry it. Checked on three
  differently-shaped objects because a `null` on one is not proof of a `null` on the others. Spotify
  no longer issues `preview_url` to client ids registered after the cutoff, and ours is one.
- **Spotify Web Playback SDK, in the app's own window** — plays DRM-protected streams, so it needs
  the Widevine CDM. Stock Electron 33.4.11 answers `NotSupportedError` for `com.widevine.alpha`;
  `org.w3.clearkey` succeeds in the same run, so the probe is sound and the absence is real. Viable
  only behind a [castlabs](https://github.com/castlabs/electron-releases) Electron build.
- **Connect transfer to the desktop Spotify client** — anticipated by
  [ADR 0014](0014-spotify-user-oauth-pkce.md) ("the foundation for Spotify Connect playback later").
  **Works.** The client showed up idle (`active=false`) and
  `PUT /me/player/play?device_id=…` started the album on it, confirmed by reading `/me/player` back.
  Curator's existing PKCE grant already carries `user-read-playback-state` and
  `user-modify-playback-state` — no new scopes, no new consent screen.

[ADR 0034](0034-amp-sonos-playback-and-card-uri.md) rejected Connect for **Amp**, and that rejection
does not transfer. It failed there because a Connect call cannot wake an **idle Sonos** — a speaker
only appears in `GET /me/player/devices` while it is already an active target. A desktop client that
is merely paused is a different case: it is a live Connect target the whole time it is running,
which is exactly what the spike observed.

## Decision

**Bench preview plays desk audio by transferring Spotify Connect to the workstation's own desktop
Spotify client, proxied through Curator. No new scopes, no repackaging.**

### 1. Curator proxies the call; the browser never holds the token

Same pattern and the same reason as the runtime-service proxies in
[ADR 0007](0007-demo-room-drives-conductor-via-curator-proxy.md): the UI asks Curator, Curator holds
the credential. Two routes, added to curator-spec.md's route table in the implementing PR (the
`spec-routes` test fails a spec row with no route behind it, so the table moves with the code, not
ahead of it):

- `POST /api/albums/:curatorId/desk-audio` — resolve `metadata.spotifyUri`, pick the desk device
  (below), transfer and play.
- `DELETE /api/albums/:curatorId/desk-audio` — pause.

Both use the existing `SpotifyAuth` token path and inherit its bounded timeout; neither reaches
Spotify without one.

### 2. Only a local `Computer` device is a legal target

Bench preview's promise is that it **touches no hardware, ever** (§6.1). Route B works by aiming at a
device id, and aiming it at the Sonos would make that promise false — the mode would take over the
listening room, which is precisely the thing §6 exists to prevent. So the device filter is part of
the promise, not a convenience:

**Curator selects only from devices of `type === "Computer"`, and never accepts a device id from the
browser.** No Computer device → the feature reports "no desktop Spotify client running here" and
bench preview stays silent and usable. Room playback remains room rehearsal's job (§6.2), through
Amp.

### 3. The takeover is stated before it happens

Transferring Connect replaces whatever the producer was listening to, and — because targeting a
device id _moves_ playback — it can also pull audio off a speaker the same account was casting to.
That is a side effect on a human, which per §10 gets said rather than done quietly: the control reads
as taking over Spotify, not as an anonymous play button, and leaving the workstation (unmount, or the
`stop` that already pauses the video) pauses what it started.

### 4. Degradation is reported, never fatal (§10)

Each failure names itself next to the control and leaves the rest of bench preview working: no
desktop client running · account is not Premium (`403 Restriction violated`) · the album has no
`metadata.spotifyUri` · Spotify unreachable. Bench preview without audio is what shipped in #92 and
is still useful.

### 5. Rejected, with what killed them

- **`preview_url` clips** — dead on availability, not on design. Nothing to build against. If Spotify
  ever restores the field for this client id, it becomes the better route (no Premium, no external
  process, no takeover) and this ADR should be revisited.
- **Web Playback SDK via a castlabs Electron build** — the only route that keeps audio inside the
  app's own window, and the only one that needs neither Premium-plus-a-running-client nor a takeover.
  Rejected for now because the cost is a **packaging change**: a different Electron distribution, a
  Widevine CDM fetch in the build, and the signing/licensing that comes with it — a large blast
  radius for a mode explicitly documented as "does not block bench preview" (§11). Kept as the named
  fallback if Connect stops being usable. The `streaming` scope Curator already requests
  ([ADR 0014](0014-spotify-user-oauth-pkce.md)) means that switch would not need re-consent either.

## Consequences

- **Bench preview stops being silent.** The "silent for now" note in `PreviewWorkstation.tsx` and the
  parenthetical in §6.1 come out in the implementing PR; §11 loses its only open question.
- **A mode that promised "always available" now has an optional external dependency** — the desktop
  Spotify client, and Premium. This is a real narrowing, mitigated by audio being _additive_: sleeve,
  palette and video are what carry most of the judgment, and they never depended on it. The
  requirement is documented at the control, per §10, not discovered.
- **Premium is now required for two things** (Amp's room playback per
  [ADR 0034](0034-amp-sonos-playback-and-card-uri.md), and desk audio) rather than one. No new
  account requirement is introduced.
- **Bench preview can move audio away from the room**, though it can never push audio to it. The
  promise §6 makes — bench never _takes over_ the listening room — holds; the honest statement of the
  edge is item 3 above.
- **`spikes/spotify-connect` earns a second use.** ADR 0034 kept it "proven but not the trigger path";
  the same token-minting and transfer call is now the basis of a shipped feature.
- **Deferred**: choosing _which_ track plays (start-of-album is the spike's behaviour and enough for
  judging a sleeve); a scrubber or transport controls in the app (the Spotify client owns transport);
  restoring whatever the producer was playing before the takeover.
