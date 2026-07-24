# ADR 0023 — Amp plays card-scanned albums over Sonos via local UPnP; cards get a distinct URI

Status: accepted · Date: 2026-07-24 · Amends: runtime-overview.md (§2 services table, §5 runtime
signals — a `card` URI kind and a fourth runtime service), integration-contract.md / scan-event
schema (`uri` now `curator:(album|card):<id>`), hue-conductor-spec.md + backdrop-spec.md (both accept
the `card` kind, treat it identically to `album`), stylus-spec.md (forwards either kind) ·
Supersedes the "Amp" sketch in docs/research/sonos-spotify-playback.md · Implements: (new) Amp
service

## Context

Marquee plays no album audio today — the tag is only an identifier, and the human drops the needle on
real vinyl (runtime-overview §11). We researched adding audio (a card scan → the album streams over
the house Sonos) in `docs/research/sonos-spotify-playback.md` and built two throwaway spikes under
`spikes/` to prove viability against real hardware. The findings, now empirical rather than
speculative:

- **Path A — local Sonos UPnP (`@svrooij/sonos`)** plays an arbitrary `spotify:album:<id>` on a
  **cold, idle** speaker. It works, but the library hardcodes the wrong Spotify service id / account
  serial (`sid=9`, `sn=7`) and modern Sonos hides the linked account (empty `/status/accounts`,
  cloud-managed auth). The spike solved this by **deriving the real `sid`/`sn`/`cdudn` token from an
  existing Sonos Spotify _favorite_** (`FV:2`) and building the container URI + metadata to match.
  Proven playing on the real system.
- **Path B — Spotify Connect (official Web API)** authenticates cleanly (Curator already runs the
  Authorization Code + PKCE flow with playback scopes — ADR 0014) but **cannot start an idle Sonos**:
  a Sonos only appears in `GET /me/player/devices` while it is already an active Connect target, and
  there is no API call to wake one. On the real system the phone/computer showed as Connect devices;
  the Sonos never did. Structurally wrong for "drop a card → an idle speaker starts."

Two design questions fall out of "make this a service":

1. **Which playback path** does the real service use?
2. **How does the service know a scan is a card (stream) vs a sleeve (don't)?** The scan event does
   **not** distinguish them today: Stylus fires the same `curator:album:<id>` for both stickers, and
   the sleeve/card split exists only as per-object _write status_ in the asset store
   (`asset.tag.sleeve` / `asset.tag.card`, curator/src/albums/asset.ts). A card and a sleeve produce
   byte-identical `ScanEvent`s.

## Decision

**Add a fourth runtime service, "Amp", that plays a scanned album's audio over Sonos via local UPnP
(Path A) — but only for scans of the `card` kind, introduced as a distinct URI on the scan event.**

### 1. Playback path: local UPnP (Path A), not Spotify Connect

Amp drives Sonos through `@svrooij/sonos` in-process (the spike's approach — no extra service to
run), mirroring how Conductor wraps a `HueDriver` behind a thin port. Rationale: Path A starts a cold
speaker, which is the whole job; Path B cannot. The Sonos hardware seam is a `SonosDriver` port
(`play(target, spotifyUri)`, `stop(target)`), so the transport (in-process `@svrooij/sonos` vs an
HTTP client to `node-sonos-http-api`) can change without touching Amp's engine.

**Account binding is derived, not hardcoded.** At startup (and on cache miss) Amp reads a Sonos
Spotify favorite from the target household (`FV:2`) to obtain the real `sid`, `sn`, and `cdudn` token,
then builds each album's container URI to match — exactly as the spike does. Requirements this
imposes, recorded here so they're not surprises: **Spotify added as a service in the Sonos app**,
**Spotify Premium**, and **at least one Spotify favorite** saved in Sonos (the binding source). If the
binding can't be derived, Amp degrades to "ignored" and logs — it never wedges.

Path B's token-minting is **not deleted**: it stays proven in `spikes/spotify-connect` for a possible
future "resume on whatever's already casting" feature, but it is not the trigger path.

### 2. Card vs sleeve: a distinct `curator:card:<id>` URI on the scan event

The Curator identifier scheme generalizes from `curator:album:<id>` to
**`curator:<kind>:<id>`** where `kind ∈ {album, card}`. Sleeves keep `curator:album:<id>`; cards are
tagged `curator:card:<id>` (same 8-char curatorId — same album, different physical object).

- **The discriminator rides on the shared scan event.** Every service already receives the event and
  looks up what it needs; putting the kind _in the URI_ keeps that fan-out pure and self-describing.
  No optional bookkeeping (the `tag.*.tagUid` capture) has to be present and correct for the split to
  work — the sticker's own bytes decide.
- **Conductor and Backdrop treat `card` identically to `album`** — a card lights up the room and
  plays the visualizer just like a sleeve; the immersive experience is the same. They gain nothing
  but a widened URI parser (strip the kind → the same curatorId → the same palette/video).
- **Only Amp gates on kind**: `card` → resolve `metadata.spotifyUri` and play; `album` → do nothing
  (you have the vinyl). A `stop` (which carries no URI) returns Amp to idle like everyone else.

Shared change: the scan-event schema `uri` pattern becomes `^curator:(album|card):[a-z0-9]{8}$`, and a
`parseCuratorUri(uri) → { kind, curatorId } | null` helper lands in `@marquee/contracts` so all four
services parse identically (replacing the duplicated `curator:album:` regexes).

**Alternative considered — match `tagUid`.** Amp could compare the scan's `tagUid` to
`asset.tag.card.tagUid` / `asset.tag.sleeve.tagUid` and gate on that, changing no shared contract.
Rejected: `tagUid` is _optional_ bookkeeping today (curator/src/albums/asset.ts — "if the writer
captured it"), so the gate would depend on data that's often absent, forcing an ambiguous default
(stream-unless-known-sleeve vs ignore-unless-known-card) — precisely the guessing the distinct URI
removes. The blast radius of the distinct URI (widen one regex in contracts + two service parsers +
Stylus pass-through) is modest and fully testable; the robustness is worth it.

### 3. Service shape mirrors Conductor (ADR 0019)

Amp is a headless Fastify service, structured 1:1 with `packages/hue-conductor`:

- `POST /api/scan` parses a `ScanEvent` (same parser shape), resolves against a **configured target**
  (a Sonos room/group name — scan carries no target), and:
  - **start**, `kind === "album"` → `202 { action:"ignored", reason:"sleeve — vinyl plays" }`.
  - **start**, `kind === "card"` → read the synced album asset; `metadata.spotifyUri` absent →
    `202 { reason:"album not on spotify" }`; asset not synced → `202 { reason:"album not synced" }`;
    else `driver.play(target, spotifyUri)` → `202 { action:"playing" }`.
  - **stop** → `driver.stop(target)` → `202 { action:"stopped" }`.
- **Graceful degradation → 202 "ignored"** for any _valid_ scan Amp can't act on (no target, album
  not synced, not on Spotify, no Sonos binding, Sonos unreachable). Only a malformed body or a URI
  that isn't `curator:(album|card):<id>` is a 4xx (runtime-overview §9).
- `X-Trigger-Secret` auth hook, config via TOML+env, a JSON `store` for the persisted target, an
  injectable `FsAlbumAssetReader` over `config.albumAssetsDir`, and a **90-minute idle timeout**
  (injected `Timers`) as the lost-`stop` safety net — all exactly as Conductor.

## Consequences

- The runtime fan-out gains a third leg: a card scan drives **lights (Conductor) + video (Backdrop) +
  audio (Amp)**; a sleeve scan drives lights + video and leaves the audio to the turntable. Marquee
  is no longer audio-silent for streaming-only albums.
- **New shared surface**: `curator:card:<id>`. The scan-event schema, `@marquee/contracts`
  (`parseCuratorUri`), Conductor, Backdrop, and Stylus all learn the `card` kind. Conductor/Backdrop
  behavior is unchanged for `album` and identical for `card`.
- **New dependency on the Sonos household state**: a Spotify favorite must exist to derive the
  account binding, and the account must be Premium with Spotify linked in the Sonos app. These are
  documented in amp-spec §Requirements and degrade to "ignored", not errors.
- **Unofficial UPnP surface**: the container URI format and the derived `sid`/`sn`/token can shift
  with Sonos firmware. The `SonosDriver` port isolates this; the fallback if it breaks is
  `node-sonos-http-api` behind the same port, or revisiting Path B for the subset of cases where the
  speaker is already active.
- **Deferred**: multi-room / `readerId`→target mapping (single configured target, matching the
  single-reader design); Amp coordinating volume or ducking with a real turntable; "resume on an
  already-casting device" via Path B. All out of scope for the first build.
