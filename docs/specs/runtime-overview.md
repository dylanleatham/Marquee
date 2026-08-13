# Runtime Overview — Marquee

_The one-page systems doc for **Marquee**, the immersive-jukebox project. Read this first before touching any individual spec. Read this last after all specs to make sure the whole picture holds together._

## 1. What Marquee is

Four services that together turn "you placed a record on the stand" into "the room becomes the record." Each service has one clear job, no visibility into any other service's internals, and can fail without taking the rest down.

## 2. The four services

| #   | Service                     | Job                                                                          | Where it lives                     | Language |
| --- | --------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | -------- |
| 1   | **Curator**                 | Own album inventory; pre-process each album into runtime assets; host Roadie | Your workstation                   | Node.js  |
| 2   | **Hue Conductor**           | Drive Hue lights from palette + pattern payloads                             | Pi 5 near TV (sibling to Backdrop) | Node.js  |
| 3   | **Stylus**                  | Read NFC tags, publish scan events                                           | Pi Zero 2 W in the album stand     | Python   |
| 4   | **Backdrop (Video Player)** | Play visualizer videos on the display                                        | Pi 5 attached to TV                | Node.js  |
| 5   | **Amp**                     | Play a **card** or **demo** scan's audio over Sonos (sleeves stay silent)    | Runtime Pi (sibling to Conductor)  | Node.js  |

> **Amp added (2026-07-24, [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md) /
> [amp-spec.md](amp-spec.md)) — core built + tested (`packages/amp`); real Sonos driver pending LAN
> verification.** The audio leg of the fan-out: a scan of a
> **card** (`curator:card:<id>`) streams the album over the house Sonos via local UPnP; a **sleeve**
> (`curator:album:<id>`) plays lights + video only — you drop the needle on the vinyl. A third kind,
> **demo** (`curator:demo:<id>`, 2026-08-08,
> [ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)), streams one chosen track instead of
> the whole album — see the §5 table. So there are
> now five services; the four-service prose and diagram below predate Amp (audio was originally out of
> scope — §11) and are read as "the pre-Amp core." Viability was proven by the spikes under
> [`spikes/`](../../spikes); Path B (Spotify Connect) was rejected because it can't start an idle
> speaker (research doc + [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md)).

Plus one internal agent, two libraries, and two data stores:

- **Roadie** — a background agent inside Curator that automates every album-onboarding step it can (metadata fetch, art download, palette generation). Not a separate service; a component within Curator. _(Prompt drafting was in this list until 2026-07-25; it is now invoked by the human rather than pipelined, because it costs Gemini calls on albums that may never need prompts — [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md).)_
- **Palette Press** — a library (not a service) used by Roadie to generate palettes from album art.
- **Observability** — a library (not a service) giving every service one log-record shape and a stable fingerprint per error, so occurrences of one bug group together across restarts and machines. Stage 2 of the error pipeline ([#142](https://github.com/dylanleatham/Marquee/issues/142) / [#144](https://github.com/dylanleatham/Marquee/issues/144)); currently used by each service's boot-failure path.
- **Album-assets store** — JSON files, one per album, produced by Curator. Contains the palette, pattern, video reference, metadata, tag payload, and Roadie state.
- **Media store** — video files on the Backdrop Pi's SD card. Populated by Curator streaming them to Backdrop (`media_transfer = "push"`, [ADR 0038](../adrs/0038-curator-pushes-media-over-http.md)), or by an out-of-band rsync (the default).

## 3. System at a glance

```
    ┌──────────────────┐
    │       You        │
    │  (add albums,    │
    │   review, tag)   │
    └────────┬─────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │           Curator              │────► Spotify Web API
    │                                │
    │   ┌──────────────────────┐     │
    │   │       Roadie         │     │
    │   │  (background agent)  │     │
    │   └──────────────────────┘     │
    │                                │
    │  uses Palette Press library    │
    └────────────────┬───────────────┘
                     │ writes
                     ▼
      ┌─────────────────────────────┐
      │   album-assets store        │
      │   {curatorId}.json          │
      │   (metadata, palette,       │
      │    pattern, video ref,      │
      │    tag payload, roadie      │
      │    state)                   │
      └────────┬────────────────────┘
               │
       ┌───────┴────────────────────┐
       │                            │
       │ read by Conductor          │ synced to Backdrop
       ▼                            ▼
   ┌────────────────┐      ┌──────────────────┐
   │ Hue Conductor  │      │    Backdrop      │
   │  (Pi 5 + TV)   │      │   (Pi 5 + TV)    │
   └────────┬───────┘      └────────┬─────────┘
            │                       │
            │ HTTPS                 │ HDMI + local video files
            ▼                       ▼
   ┌────────────────┐      ┌──────────────────┐
   │  Hue Bridge    │      │    Display       │
   │  (LAN)         │      └──────────────────┘
   └────────┬───────┘
            │ Zigbee
            ▼
      [ Hue Lights ]

            ▲                       ▲
            │                       │
            └────── scan events ────┘
                        │
                ┌───────┴────────┐
                │  Stylus   │
                │ (Pi 0 in stand)│
                └───────┬────────┘
                        │
                reads NTAG213
                        │
                [ Sleeve on stand ]
```

## 4. Data stores

### album-assets store

- **Primary location**: `~/marquee/album-assets/` on your workstation (Curator writes here)
- **Synced location**: the same path on **every host that reads it** — the Pi 5, where Conductor reads it at scan time and Amp reads it from the same directory, and the desktop shell's own co-located Conductor when one is running. Curator pushes to each ([ADR 0079](../adrs/0079-the-asset-push-has-more-than-one-target.md); see §8), so "the synced copy" is a list, not a machine
- **Shape**: one JSON file per album, keyed on curatorId (an 8-character base32 identifier generated at add-time)
- **Contents per file**: album metadata (title, artist, year, genres, Spotify URI if available), the extracted palette (colors with hex + role + source swatch), the pattern selection (type + params), the drafted video and card-art prompts, video reference (fileId, duration, loop strategy), card art reference (Curator-only), tag payload with per-object write status (sleeve, card and demo tag tracked separately), the chosen demo track if there is one ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md) — the _choice_ only, never the tracklist), verification timestamps, and Roadie's state machine progress
- **Writer**: Curator (only)
- **Readers**: Conductor (for palette/pattern lookup at scan time), Curator itself, humans (git)
- **Sync to Backdrop**: a projection of this store (URI → filePath + metadata) is pushed to Backdrop's `library.json` — Backdrop doesn't need or see the full asset details
- **In git**: yes. It's small, human-readable, and the diff-per-week of your collection is genuinely useful. `.bak` on every write.

### media store

- **Primary location**: `~/marquee/media/` on your workstation (Curator manages)
- **Synced location**: same path on the Pi 5, where Backdrop reads from at playback time
- **Structure**: subdirectories for `visualizers/`, `artwork/`, `artwork-overrides/`, `thumbnails/`, and `incoming/`
- **Shape**: `.mp4` files named by fileId (usually the same as curatorId); `.jpg` files for art and thumbnails. One reserved name: `visualizers/default.mp4`, the clip Backdrop plays for a record with no visualizer of its own ([ADR 0073](../adrs/0073-a-record-with-no-visualizer-plays-the-default.md)). It belongs to no album, so it is never _attached_ to one — you choose it in Curator's Settings, which ingests it like any visualizer (decode budget included) and sends it over `PUT /api/media/default` ([ADR 0074](../adrs/0074-the-default-visualizer-is-chosen-in-curator.md)). Dropping it in by hand still works.
- **Writer**: Curator's video-upload and Roadie's art-download flows write to the workstation copy; a periodic `rsync` (or syncthing) syncs to the Pi 5
- **Reader**: Backdrop
- **In git**: no. Too big, binary, out-of-band sync is more appropriate.

## 5. Runtime signals

Everything at runtime is driven by one event shape, published by the Stylus:

```json
{
  "event": "start" | "stop",
  "uri": "curator:album:2k7bxq9m",    // only on start; kind is album | card | demo
  "tagUid": "04:A1:B2:C3:D4:E5:F6",   // only on start
  "readerId": "primary",              // stand identifier for multi-reader future
  "at": "2026-07-06T20:15:22Z"
}
```

The `uri` is Curator's internal identifier scheme, `curator:<kind>:<curatorId>`, not a Spotify URI. This keeps the identifier stable regardless of whether an album is on Spotify — Curator can host records that don't exist on streaming services at all. **Conductor and Backdrop treat every kind identically** (lights + video — it is the same record); only Amp acts on the difference:

| `kind`  | Physical object            | What Amp does                                                                                                                                                         |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `album` | the record **sleeve**      | nothing — you drop the needle on the vinyl                                                                                                                            |
| `card`  | the printed **shelf card** | streams the whole album over Sonos                                                                                                                                    |
| `demo`  | a **demo tag**             | streams the one track chosen for the album — as a position inside it ([ADR 0078](../adrs/0078-a-demo-cut-plays-as-a-position-in-the-album.md)) — else the whole album |

`album`/`card` are [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md); `demo` is [ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md), where the chosen track lives on the album asset (`demoTrack`) rather than in the tag, so changing your mind doesn't mean re-writing a sticker. A demo tag with no track chosen plays the album — deliberately, since a silent tag is indistinguishable from a mis-written one. (Before ADR 0034 the only kind was `album`.) The kinds are enumerated as `CURATOR_URI_KINDS` in `@marquee/contracts`, which is what the contract tests iterate.

Fired to both Conductor (`/api/scan`) and Backdrop (`/api/scan`) in parallel. Both services independently look up what they need (Conductor reads the album-assets store; Backdrop reads its library.json).

> **Both halves built (2026-07-22):** Backdrop's `/api/scan` (build step 8) and now Conductor's ([issue #45](https://github.com/dylanleatham/Marquee/issues/45) / [ADR 0019](../adrs/0019-conductor-scan-reads-asset-store.md)) both exist, so a raw scan drives lights _and_ video — the full "place sleeve → room becomes the record" loop (§10 step 11). Conductor reads its synced copy of the album-assets store at scan time via the shared `buildPalettePayload` in `@marquee/contracts`.

**Fan-out over centralization**: there is no central "playback state" service. Conductor and Backdrop each own their own state, driven by the same events. This is a deliberate choice — simpler failure modes, no orchestrator to become a single point of failure, and each service is testable in isolation.

## 6. The full loop (narrative)

**Setup phase** (once, when adding an album):

1. You add an album via Curator's Add screen (Spotify search, paste URI, or manual entry). Curator assigns a curatorId.
2. Roadie picks it up automatically: fetches Spotify metadata, downloads art, runs Palette Press. Sets album state to `awaiting_review`.
3. You open Curator's queue view when you have time. Album appears under "Needs you right now → Awaiting review."
4. You review the palette (adjust if needed). If you need a video prompt, you ask for one — drafting is invoked, not pre-computed ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)) — then copy it and launch your video tool. If you already have the video, skip straight to attaching it; nothing is gated by state ([ADR 0026](../adrs/0026-album-detail-is-a-workbench.md)).
5. You generate a video externally, come back to Curator, attach the file.
6. You bench-preview sleeve + palette + video together in Curator (no hardware touched). Approve. Optionally arm the room and run a full rehearsal against the real lights, display and Sonos ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)).
7. You use NFC Tools on your phone to write `curator:album:<curatorId>` to an NTAG213 sticker; stick on the sleeve; mark as written in Curator.
8. You physically verify: place sleeve on stand, watch runtime react. Mark verified.

**Runtime phase** (every time you play the album):

1. You pull the sleeve off the shelf, place it on the stand.
2. Stylus polls, detects the tag, reads the URI, debounces (400ms).
3. Stylus fires `{ event: "start", uri, tagUid, readerId, at }` to Conductor and Backdrop in parallel.
4. Conductor: looks up the album in its local view of the assets store, finds palette + pattern, snapshots current light state, applies the palette across the room using the pattern's rules.
5. Backdrop: looks up the URI in library.json, finds the filePath — or the default clip, if this record has no visualizer of its own yet ([ADR 0073](../adrs/0073-a-record-with-no-visualizer-plays-the-default.md)) — and sends a `play` command to the browser over WebSocket. Browser crossfades from idle overlay to the new video, loops.
6. You drop the needle. The room is now the record.
7. Side ends. You lift the sleeve.
8. Stylus sees no tag for ~2s, fires `{ event: "stop", at, readerId }`.
9. Conductor: fades lights back to the snapshotted pre-scan state.
10. Backdrop: fades video out, idle overlay back in.

**Safety-net phase** (when things go wrong):

- If either Conductor or Backdrop misses the `stop` event (WiFi drop, service restart, whatever), an idle timeout after 90 minutes of no events fires an internal stop. Purple Rain doesn't play until morning.
- If the Stylus can't reach a downstream service, it retries 3× over ~2.5s and gives up, logging.
- If Backdrop is asked to play a URI that's **not in its library**, it stays in its current state and shows a small corner indicator — `video not in library` ([backdrop-spec §10](backdrop-spec.md#10-frontend-spa-structure) owns the wording). No crash, no black screen.
- If the URI **is** in the library but the record has no visualizer of its own, or its file is missing on disk, Backdrop plays its **default clip** ([ADR 0073](../adrs/0073-a-record-with-no-visualizer-plays-the-default.md)) and reports `usingDefault: true` on `/api/status`. Nothing requires a visualizer before a record is tagged and shelved, so this is the ordinary state of a collection midway through its visualizers, not an error. With no default clip on the Pi it degrades to the stay-put behaviour above, with `no visualizer yet` or `video file missing` respectively.

## 7. Deployment topology

**Curator on your workstation + one runtime Pi + one stand Pi.**

- **Your workstation** (Windows/Mac/Linux, not always on): runs Curator.
- **Pi 5 near TV**: runs Conductor + Backdrop as sibling processes.
- **Pi Zero 2 W in stand**: runs Stylus.

> **Launcher (2026-07-17, [ADR 0008](../adrs/0008-desktop-app-supervises-services.md)):** on the
> workstation, Curator (and a co-located Conductor, for the Demo Room's real-lights preview before
> the Pi exists) can be launched as a single **desktop app** (`packages/desktop`, Electron) instead
> of hand-started dev servers. It's purely a launcher/shell — this topology is unchanged, and the
> services still run headless for the Pi and CI.
>
> **Amended 2026-08-02 ([ADR 0050](../adrs/0050-the-desktop-health-gate-checks-identity-not-liveness.md)):**
> the one thing the services did gain is identity on `/healthz` — `service`, `instance` and their
> resolved directory. The shell gates its window on those rather than on a bare 200, because a 200
> from a stale service in another checkout looked identical and got driven as if it were the app's
> own ([issue #229](https://github.com/dylanleatham/Marquee/issues/229)). On the Pi `instance` is
> `null` and nothing else changes.

The mental model is **config vs. runtime**: Curator is a configuration/admin tool that runs on your usual dev machine when you're actively working with the collection; the runtime Pi is an always-on appliance that runs whenever the experience is active. They don't need to be running simultaneously — you can add albums today with the runtime off, or listen to records tonight with your laptop shut.

Advantages of this split:

- Curator development and use happens on your comfortable workstation (bigger screen, faster CPU, real IDE, familiar tools).
- The runtime Pi's resources are dedicated to runtime work; no contention with Curator's occasional heavy operations.
- The experience doesn't depend on your workstation being on.
- Curator and the runtime are cleanly decoupled — you could reinstall your workstation tomorrow without touching the runtime.

Costs:

- Curator has to push updates to the runtime Pi over the LAN (rsync for asset store and media, HTTP for Backdrop's library.json). Well-defined, but one more moving part than sharing a filesystem.
- If you're mid-Curator-session and someone plays a record, the runtime reads whatever it last synced — not what's currently on the workstation. Fine in practice; worth being aware of.

The Hue bridge, both Pis, and workstation must be on the same LAN. Conductor talks to the bridge over local HTTPS; Stylus talks to Conductor and Backdrop over LAN HTTP.

## 8. Cross-cutting concerns

### Auth

Everything on the LAN, so this is "just enough to prevent accidents," not real security. Shared secret in an `X-Trigger-Secret` header on all service-to-service calls. Rotate if compromised; otherwise leave alone. Store in each service's config file.

Curator's UI runs on your local network with no auth (analogous to Home Assistant, Pi-hole, etc.). If you ever expose anything beyond the LAN, revisit.

### Idle timeouts

Both Conductor and Backdrop implement an idle timeout: if no scan event has arrived in 90 minutes and the service is in a non-idle state, restore idle. This is the safety net for lost `stop` events. Not a substitute for real event delivery — a workaround for a well-understood failure class.

### Idle cost

Distinct from the idle _timeouts_ above: that is about state, this is about what the system costs
while sitting in that state. Because every service is always-on, idle cost is a product requirement,
and it is measured rather than assumed — **no configuration exceeds 1.2% of one CPU core at zero
traffic** (measured 2026-08-02, [#137](https://github.com/dylanleatham/Marquee/issues/137)). Numbers,
budgets and how to re-measure: [idle-cost-baseline.md](idle-cost-baseline.md). The audit also refuted
its own leading hypothesis — `pnpm dev`'s watchers are _cheaper_ on CPU than the packaged desktop app,
and dev mode's real cost is memory. Enforcement is a reviewer rule plus two assertions on the desktop
shell, deliberately not a CI check
([ADR 0049](../adrs/0049-idle-cost-is-a-measured-baseline-not-a-ci-gate.md)).

### Sync strategies

- **Curator → Backdrop metadata**: HTTP push after each save **that changes what Backdrop plays** — a video attach or detach (both upserts) and an album delete or merge (remove) — via `POST /api/library/update` / `DELETE /api/library/:uri`, plus a full-reconcile `POST /api/library/sync`. Small, atomic, fast. ([ADR 0015](../adrs/0015-backdrop-sync-triggered-at-projection-changes.md), build step 9.)

> **Amended 2026-08-12 ([ADR 0073](../adrs/0073-a-record-with-no-visualizer-plays-the-default.md)).**
> This line used to read "a video attach (upsert), detach, or album delete (remove)", with the aside
> that "an album still in Roadie's pipeline has no video to project". Both halves are now wrong:
> **every** album Curator holds is projected, one with no visualizer as `usesDefault`, so a detach
> _rewrites_ the entry instead of deleting it and removal is reserved for the album ceasing to exist.
> The old shape left Backdrop unable to tell an unfinished record from a tag nothing knows.

- **Curator → Backdrop videos**: streamed by Curator over HTTP (`PUT /api/media/:fileId`, `media_transfer = "push"` — [ADR 0038](../adrs/0038-curator-pushes-media-over-http.md)), skipping files whose `contentHash` Backdrop already reports; or `rsync`/`syncthing` out of band (`media_transfer = "none"`, the default). Big files, tolerant of long-running transfer.
- **Curator → Conductor asset store**: HTTP push, `PUT /api/album-assets/:curatorId` ([ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)). Fires on a video change, on **verify**, on the per-album `POST /api/albums/:curatorId/push`, for the whole library from `POST /api/runtime/sync` (a background job), and — since 2026-08-12, [ADR 0077](../adrs/0077-an-edit-that-changes-what-the-room-plays-pushes-it.md) — on **every edit that changes what the room plays**: the demo cut, the album's Spotify URI, the palette, the motion override, and the cover. **Amp reads the same directory** and is served by the same push. The push has a **list** of targets since 2026-08-13 ([ADR 0079](../adrs/0079-the-asset-push-has-more-than-one-target.md)), because more than one host reads the store — a desktop shell's own Conductor and the runtime Pi's, at once. `rsync` still works for a bulk first load, but is no longer required.

> **Why the edits had to be added ([ADR 0077](../adrs/0077-an-edit-that-changes-what-the-room-plays-pushes-it.md), fixes [#304](https://github.com/dylanleatham/Marquee/issues/304)).** The four original triggers are milestones in
> getting a record onto the shelf, and `verified` is terminal — so everything you change about a
> finished record reached the runtime only if you remembered to press **Sync everything**. Every demo
> tag played its album from track 1 for exactly this reason. Library **sweeps** still do not push per
> album: they end in their own report, and the sync button is what follows them.

> **Corrected 2026-08-01 ([ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)).** This
> line previously read _"`rsync` push … Curator handles this as an automatic post-save action so it
> feels the same as the Backdrop HTTP push"_ — describing a feature that had never been built, while
> [runbook A4.3](../runbook.md) said to run `rsync` by hand. The runtime consequently sat six albums
> behind the workstation for four days with no scan ever driving the lights, and nothing in Curator
> could say so. The push described above is now real; this note stays as the record of why.

- **Spotify Web API → Curator**: called by Roadie during the album-onboarding pipeline (metadata + art). Read-only. Uses existing OAuth credentials (reuse from your Conflicted Lineup app if convenient).

### Error handling philosophy

Every service is expected to:

1. **Degrade gracefully**, not crash. Missing data → quiet indicator, stay in current state.
2. **Log verbosely at the point of failure**, not in call sites. `journalctl -u <service>` should tell you what happened.
3. **Retry briefly on transient failures**, then move on. Long queues of stale events are worse than dropped events for this domain.

## 9. Failure modes (curated list)

Every row below has a unit test behind it **and** a bench drill in
[failure-drills.md](../failure-drills.md) — the tests prove the logic handles the failure, the drills
prove the failure reaches that logic on real hardware. Change a row here and change the drill with it.

| Failure                             | Detected by                                         | User-visible effect                                    | Recovery                                                                            |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Hue bridge unreachable              | Conductor                                           | Scan → 502 → lights don't change                       | Auto: retry next scan. Manual: check bridge power/network.                          |
| Video file missing on Backdrop's SD | Backdrop                                            | Default clip plays; `video file missing` if none       | Manual: run sync from Curator.                                                      |
| Record has no visualizer yet        | Backdrop                                            | Default clip plays; `no visualizer yet` if none        | Manual: attach a visualizer in Curator. Not urgent — the record still plays.        |
| Album not in library                | Backdrop                                            | Small `video not in library` indicator                 | Manual: the tag names nothing Curator holds — check the sticker's URI.              |
| Stylus can't reach Conductor        | Stylus                                              | Fast-blink LED, no lights change                       | Auto: retry 3×, then log. Manual: check WiFi.                                       |
| Lost `stop` event                   | Conductor + Backdrop                                | Effect continues after sleeve removed                  | Auto: idle timeout (90 min). Manual: see [failure-drills D1](../failure-drills.md). |
| Curator down                        | Everything downstream                               | Runtime works with last synced state; can't add albums | Manual: restart Curator, resync.                                                    |
| Backdrop Chromium crash             | Backdrop                                            | Black display                                          | Auto: systemd restarts. Watchdog checks WebSocket connection.                       |
| NFC read misdetected                | Stylus + downstreams                                | Wrong album loads (rare)                               | Manual: swap sleeve. Or wait for tag-removal timeout.                               |
| Bad JSON in asset file              | Curator (validation on save) or Conductor (on read) | Curator refuses to save; Conductor logs and stays idle | Manual: fix JSON. `.bak` file has last-good version.                                |

## 10. Suggested development order

Build in an order where each step is demoable and each subsequent step compounds on the last.

1. **Conductor + a hand-crafted palette JSON.** Fastest way to see lights react. No album lookup, no NFC, no video. Just: `curl` a palette payload at Conductor, room changes. Proves the hardest concrete integration (Hue's local API + palette semantics).
2. **Palette Press library, run once on one album.** CLI, no service yet. Prove the extraction pipeline produces good palettes from real album art.
3. **Curator, minimal.** Asset store scaffolding, manual add-album via a simple form, Palette Press integration. Skip UI polish. Prove one album can go from add to palette-saved.
4. **Spotify integration in Curator.** Add via URI + search, real metadata + art fetch. Success: paste a URI, get a real album on disk.
5. **Roadie skeleton.** Background worker + state machine + persistence. First with mocked sub-steps, then wire in Palette Press and Spotify. Success: add an album, walk away, come back to `awaiting_review`.
6. **Curator UI: queue view + album detail.** The primary screens. This is where you'll spend evenings for a while.
7. **Video upload + attachment flow.** Add videos as they become available from the external AI service. Preview screen for confidence.
8. **Backdrop, minimal.** Kiosk Chromium, hardcoded video, HTTP endpoint. Prove the play-loop-transition experience feels good.
9. **Backdrop library sync from Curator.** Now you can add an album in Curator and see it play in Backdrop.
10. **Stylus, on the bench.** Read tags, publish events to `curl`-able stub endpoints. Wire real endpoints. Prove the full software chain.
11. **Physical stand integration.** Mount the Stylus, tune positioning, tag your first sleeves. First real "place record, room changes" moment.
12. **Iterate on failure modes, then everything else.** Idle timeouts, missing-file handling, LED patterns, sync verification, Roadie retry polish. Worked drill by drill in [failure-drills.md](../failure-drills.md), the §9 companion to the bring-up checklist.

Steps 1–5 are backend-only and can happen in a coffee shop. Steps 6–9 need a Hue bridge and a display. Steps 10–11 need the physical setup.

## 11. What's not in this system (yet)

Things deliberately left out of the current design, in case you're wondering:

- **Audio identification of the record** (Shazam, mic input) — the tag is the identifier. (Amp
  _plays_ audio for card scans — [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md) — but never _listens_; identification stays out.)
- **Real-time audio-reactive effects** — patterns are pre-decided; no live audio feedback loop.
- **Multi-track pattern changes** within an album — one palette per album, plays for the whole record.
- **Multiple readers / multiple displays** — the field is there (`readerId`), the code isn't.
- **A mobile app for override control** — the phone can hit the local web UIs directly.
- **Auto-generation of visualizers** — external AI service, out of scope for these specs.
- **Cloud sync, remote control, or off-LAN access** — everything is local.
- **Real security** — LAN-only, shared secret is "prevent accidents," not "resist attackers."

Most of these are natural extensions with clear seams. The system is designed to accept them without a rewrite.

## 12. Naming

The project is **Marquee** — the lit-up front of a theater or jukebox that tells you what's playing and draws you in. Fits the immersive-jukebox framing: a marquee is functional (announces the show) and expressive (part of the show itself).

The services all share a backstage-of-a-live-show theme:

- **Curator** — assembles the collection and decides how each album will be presented
- **Roadie** — background agent inside Curator that does the setup work before you take the stage
- **Hue Conductor** — leads the light performance in response to scan events
- **Stylus** — reads the record (metaphorically and literally, via NFC)
- **Backdrop** — the visual scene that plays behind the record
- **Palette Press** — library that presses colors out of album art, like a record press

These are the committed names throughout the specs. If any need to change later, that's a rename PR touching the whole repo — worth it if the name is genuinely wrong, but not worth it for cosmetics.
