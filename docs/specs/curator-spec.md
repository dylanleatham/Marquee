# Curator — Technical Spec

_The tool that curates your collection's presentation assets. Standalone admin app; source of truth for what's in the experience._

## 1. Purpose

A local admin app that is the source of truth for **which albums are in the experience**. Curator owns the album inventory, coordinates the flow of getting each album from "just added" to "fully working on a physical scan," and hosts Roadie (the background agent that automates every step it can).

The album identifier used throughout the system is **`curator:album:<curatorId>`** — an internal identifier owned by Curator. Spotify URIs, when available, are stored as metadata on the album record and used for auto-fetching art and metadata, but they're never the runtime identifier. This means albums that don't exist on Spotify (rare pressings, private releases) work exactly like albums that do.

## 2. Success criteria

**Add 10 albums via the Add screen. Walk away. Come back to a queue of albums in "awaiting your review" state, each with palette, art, video prompt, and card art prompt ready. Work through each one in a session (per the album onboarding workflow). End with 10 fully-configured, playable albums.**

The queue-first workflow — Roadie does everything it can, humans work through what's left — is what makes 500 albums a realistic target instead of a fantasy.

## 3. Scope

### In scope

- Album inventory management: add via Spotify search, paste URI, paste batch, or fully manual entry
- Roadie: background agent processing newly-added albums through pre-video work (specified in its own doc)
- Palette generation via Palette Press library; hand-editing per album; batch regeneration
- Video upload and attachment (drag-and-drop, `/incoming/` watch)
- Video thumbnail generation and format validation
- Album-assets store on disk (JSON, human-readable, git-friendly)
- Media store on disk for video files, artwork, thumbnails (out of git)
- Queue-view UI as the primary screen
- Album detail UI (session-shaped, per the onboarding workflow)
- Add album UI (search, paste, manual)
- In-app preview (palette animating alongside video; no hardware needed)
- Tag payload UI (URI + QR + mark-as-written)
- Simulate scan against runtime services for pre-physical verification
- Backdrop sync (library metadata push + media rsync trigger)
- Override art support (upload your own JPG when Spotify's isn't right)
- Application settings management (listening room, service URLs) with push-on-change to Conductor and Backdrop

### Out of scope

- NFC reader integration (phone handles tag writing)
- Runtime playback (Conductor and Backdrop own that)
- Video transcoding (validate-and-move only; reject bad formats with a clear error)
- Auto-generation of videos (external service, no API)
- Multi-user or cloud sync
- Audio-feature-driven pattern selection (Spotify Audio Features deprecated; static defaults fine)
- Track-level or per-side asset variation

## 4. Where Curator fits

```
                    ┌─────────────────┐
                    │       You       │
                    │  (add, review,  │
                    │   tag, verify)  │
                    └────────┬────────┘
                             │
                             ▼
        ┌────────────────────────────────────────┐
        │              Curator                   │
        │                                        │
        │  ┌──────────────────────────────────┐  │
        │  │       HTTP API + Web UI          │  │
        │  └──────────────┬───────────────────┘  │
        │                 │                      │
        │                 ▼                      │
        │  ┌──────────────────────────────────┐  │
        │  │           Roadie                 │──┼──▶ Spotify Web API
        │  │      (background agent)          │  │
        │  └──────────────┬───────────────────┘  │
        │                 │                      │
        │                 ▼                      │
        │  ┌──────────────────────────────────┐  │
        │  │       Palette Press (library)    │  │
        │  └──────────────────────────────────┘  │
        └───────────────────┬────────────────────┘
                            │ writes
              ┌─────────────┴─────────────┐
              ▼                           ▼
    ┌──────────────────────┐  ┌──────────────────────┐
    │  album-assets store  │  │     media store      │
    │   {curatorId}.json   │  │   visualizers/       │
    │                      │  │   artwork/           │
    │                      │  │   thumbnails/        │
    └──────────┬───────────┘  └──────────┬───────────┘
               │                         │
    read at runtime by Conductor    synced to Backdrop
               │                         │
               ▼                         ▼
    ┌────────────────────┐    ┌────────────────────┐
    │   Hue Conductor    │    │      Backdrop      │
    └────────────────────┘    └────────────────────┘
```

Roadie lives inside Curator — same Node process, same asset store, same config. External runtime services (Conductor, Backdrop, Stylus) don't know Roadie exists; they just consume the assets Curator writes.

## 5. Recommended tech stack

Optimized for Windows dev, Node ecosystem, and Claude Code compatibility.

- **Runtime**: Node.js 20 LTS, TypeScript
- **Server framework**: Fastify (consistency with other services)
- **Palette generation**: Palette Press as an internal npm package (or monorepo workspace package)
- **Spotify Web API**: any thin client library, or bare `fetch` calls. Reuse OAuth credentials from your existing Conflicted Lineup app if convenient.
- **Video validation + thumbnails**: `fluent-ffmpeg` wrapper + system `ffmpeg` binary
- **File watching**: `chokidar` for the `/incoming/` folder
- **UI**: React + Vite. TanStack Query for data fetching (invalidation semantics matter here). Multi-screen: queue, add-album, album-detail, preview, incoming.
- **Storage**: JSON files on disk for the asset store; SQLite optional for a lookup index if collection grows beyond ~1000 albums
- **Short ID generation**: `nanoid` with a base32 alphabet, 8 characters, for curatorIds
- **Roadie's worker loop**: no external job queue library needed. A simple `while (queue.hasWork()) { await process(queue.next()) }` inside the same process fits the personal-collection scale the app is built for (hundreds to low thousands of albums, human-triggered add rates).

## 6. On-disk layout

```
marquee/
├── album-assets/                       # asset store — keyed on curatorId
│   ├── 2k7bxq9m.json
│   ├── 4h8mzp2n.json
│   └── ...
├── media/
│   ├── artwork/                        # downloaded Spotify art
│   │   ├── 2k7bxq9m.jpg
│   │   └── ...
│   ├── artwork-overrides/              # user-uploaded art that takes precedence
│   │   └── 4h8mzp2n.jpg
│   ├── card-art/                       # business-card art per album (Curator-only)
│   │   └── 2k7bxq9m.png
│   ├── visualizers/                    # video files
│   │   └── 2k7bxq9m.mp4
│   ├── thumbnails/                     # jpg previews
│   │   └── 2k7bxq9m.jpg
│   └── incoming/                       # drop zone for new videos and card art
│       └── (unclaimed files)
└── logs/
    └── curator.log
```

**curatorId** is generated at album-add time — an 8-character base32 identifier (`nanoid` with a custom alphabet). It's the primary key for everything: filenames, tag payloads, HTTP paths, cross-service lookups. Immutable once assigned.

Spotify's album ID lives in the asset file as a reference, not a filename component. This means renaming or removing the Spotify integration later doesn't require file migrations.

## 7. Album-assets file shape

One JSON file per album. Human-readable, git-friendly, hand-editable.

```json
{
  "version": 1,
  "curatorId": "2k7bxq9m",
  "createdAt": "2026-07-06T20:15:22Z",

  "metadata": {
    "name": "Purple Rain",
    "artist": "Prince",
    "year": 1984,
    "genres": ["funk", "rock", "pop"],
    "source": "spotify",
    "spotifyUri": "spotify:album:1C2h7mLntPSeVYciMRTF4a",
    "spotifyArtUrl": "https://i.scdn.co/image/..."
  },

  "artwork": {
    "resolvedPath": "media/artwork/2k7bxq9m.jpg",
    "overrideActive": false,
    "contentHash": "sha256:abc123..."
  },

  "palette": {
    "colors": [
      { "hex": "#4B0082", "role": "primary", "sourceSwatch": "DarkVibrant" },
      { "hex": "#8A2BE2", "role": "secondary", "sourceSwatch": "Vibrant" },
      { "hex": "#FFD700", "role": "accent", "sourceSwatch": "LightVibrant" }
    ],
    "generatedAt": "2026-07-06T20:15:44Z",
    "algorithm": "palette-press@0.1.0",
    "handEdited": false
  },

  "pattern": {
    "type": "crossfade",
    "params": { "transitionMs": 12000, "holdMs": 45000 },
    "handEdited": false
  },

  "promptDrafts": {
    "video": {
      "text": "For the album \"Purple Rain\" by Prince (1984). Genre context: funk, rock, pop. Color palette to draw from:\n  - #4B0082 (primary)\n  - #8A2BE2 (secondary)\n  - #FFD700 (accent)\nAbstract flowing shapes with soft edges...",
      "template": "abstract_flow",
      "generatedAt": "2026-07-06T20:15:46Z"
    },
    "cardArt": {
      "text": "Business-card sized art for \"Purple Rain\" by Prince (1984). Iconic emblem style. Color palette:\n  - #4B0082 (primary)\n  - #8A2BE2 (secondary)\n  - #FFD700 (accent)\nA single evocative image that reads at business-card scale...",
      "template": "iconic_emblem",
      "generatedAt": "2026-07-06T20:15:46Z"
    }
  },

  "visualizer": {
    "fileId": "2k7bxq9m",
    "originalFilename": "prince-purple-rain-v3.mp4",
    "durationSec": 187,
    "resolution": "1920x1080",
    "loopStrategy": "loop",
    "attachedAt": "2026-07-06T20:32:00Z",
    "notes": ""
  },

  "cardArt": {
    "fileId": "2k7bxq9m",
    "originalFilename": "prince-purple-rain-card-v2.png",
    "resolution": "1050x600",
    "orientation": "landscape",
    "attachedAt": "2026-07-06T20:34:00Z",
    "notes": ""
  },

  "tag": {
    "payload": "curator:album:2k7bxq9m",
    "sleeve": {
      "written": true,
      "writtenAt": "2026-07-06T20:41:00Z",
      "tagUid": "04:A1:B2:C3:D4:E5:F6"
    },
    "card": {
      "written": true,
      "writtenAt": "2026-07-06T20:43:00Z",
      "tagUid": "04:11:22:33:44:55:66"
    }
  },

  "verification": {
    "previewApprovedAt": "2026-07-06T20:38:00Z",
    "physicallyVerifiedAt": "2026-07-06T20:52:00Z"
  },

  "roadie": {
    "state": "verified",
    "subState": null,
    "flags": {
      "palette_insufficient": false,
      "album_not_on_spotify": false,
      "art_override_active": false
    },
    "history": [
      { "state": "fetching_metadata", "at": "2026-07-06T20:15:23Z" },
      { "state": "downloading_art", "at": "2026-07-06T20:15:25Z" },
      { "state": "generating_palette", "at": "2026-07-06T20:15:44Z" },
      { "state": "drafting_prompts", "at": "2026-07-06T20:15:45Z" },
      { "state": "awaiting_review", "at": "2026-07-06T20:15:47Z" }
    ],
    "lastError": null,
    "retryCount": 0,
    "syncIssues": []
  },

  "status": {
    "highLevel": "verified",
    "next": null,
    "issues": []
  }
}
```

Notes on the shape:

- `metadata.source` distinguishes `"spotify"` from `"manual"` — manual albums lack `spotifyUri` and `spotifyArtUrl`, and have artwork sitting only in `media/artwork-overrides/`.
- `artwork.resolvedPath` points to whichever art is currently active (override takes precedence). Palette regenerates when this changes.
- `promptDrafts` holds all generated prompts, one per output type. Currently `video` and `cardArt`; the shape generalizes to any future output type without schema changes.
- `visualizer` is the runtime-facing video referenced by Backdrop.
- `cardArt` is Curator-only — the business-card-sized image printed onto physical cards. Backdrop and Conductor don't consume it.
- `tag.payload` is the string written to both sleeve and card stickers — same URI on both physical objects.
- `tag.sleeve` and `tag.card` track write status per physical object separately, since one may exist without the other (e.g., sleeve tagged today, card printed and tagged next week).
- `roadie` section owns Roadie's state machine (per the Roadie spec).
- `roadie.syncIssues` records any problems Roadie encountered while propagating changes to Backdrop (missing files, failed rsync, stale metadata). Each entry has a timestamp, trigger (`video_attach` or `verified`), and human-readable message. Cleared when the issue is resolved or a subsequent successful sync supersedes it. The album's `status.issues` (derived) surfaces the count so it's visible in the queue view.
- `status` is derived, not stored. Kept in the JSON for convenience of read-only consumers; recomputed on every save.

## 8. HTTP API

Runs on `http://localhost:4739` locally.

### Inventory (adding and removing albums)

> **Implemented shape (build step 3, 2026-07-11):** manual add uses **`multipart/form-data`**
> (fields `name`, `artist`, `year?`, `genres?` + an `artwork` file), not a JSON `{ mode, … }`
> body — because manual entry requires a binary cover upload (spec §10), which JSON can't carry
> cleanly. It returns `{ curatorId, state, paletteColors, paletteInsufficient }` and runs Palette
> Press synchronously (Roadie makes it a background enqueue in step 5). Step 4 adds the Spotify
> path (a JSON body, art fetched by URL); the two modes will share this endpoint, with content
> type selecting the mode. The `{ mode }` envelope below is the original sketch.
>
> **Spotify add (build step 4):** a JSON body `{ spotifyUri }` or `{ spotifyId }` fetches real
> metadata + cover art (client-credentials flow), dedupes on the Spotify URI (**409** with the
> existing `curatorId` if already added), then runs Palette Press. The add response includes a
> `source` field (`"manual" | "spotify"`). `GET /api/spotify/search-albums?q=` and
> `GET /api/spotify/album/:spotifyId` back the search/preview UI. All Spotify routes **503** when
> no credentials are configured.

| Method | Path                     | Purpose                                                                                                                                                             |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/albums`            | Add an album. Body: `{ mode: "spotify" \| "manual", spotifyUri?, searchQuery?, manualMetadata? }`. Returns `{ curatorId }`. Enqueues in Roadie for auto-processing. |
| POST   | `/api/albums/batch`      | Add multiple albums. Body: `{ items: [{ mode, spotifyUri? \| searchQuery? \| manualMetadata? }] }`. Returns `{ curatorIds: [] }`. Each item enqueues separately.    |
| GET    | `/api/albums`            | List all albums. Query params for filtering: `?state=awaiting_review`, `?query=text`.                                                                               |
| GET    | `/api/albums/:curatorId` | Full asset file + derived status.                                                                                                                                   |
| DELETE | `/api/albums/:curatorId` | Remove from Curator. Query params: `?deleteMedia=1` also removes associated video and art files. Does NOT untag; that's a physical action you have to do yourself.  |

### Spotify search (for the Add screen)

| Method | Path                            | Purpose                                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/spotify/search-albums?q=` | Autocomplete album search. Returns candidates with cover art thumbnails. |
| GET    | `/api/spotify/album/:spotifyId` | Preview one album's Spotify metadata before adding.                      |

### Queue (primary UI backing)

| Method | Path                | Purpose                                                                                                                                                                                                                                                                                                                       |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/queue`        | Returns albums grouped by human-facing state. Shape: `{ awaiting_review: [], awaiting_video: [], awaiting_preview: [], awaiting_tag_write: [], awaiting_verify: [], errored: [], needs_manual: [], done_recently: [] }`. Each entry: minimal album summary (curatorId, art thumbnail, title/artist, entered-state timestamp). |
| GET    | `/api/queue/counts` | Just the counts per bucket. For the tab-title indicator.                                                                                                                                                                                                                                                                      |

### Palettes

| Method | Path                                      | Purpose                                                            |
| ------ | ----------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/albums/:curatorId/palette/generate` | Runs Palette Press. Skips if hand-edited unless `?force=1`.        |
| PUT    | `/api/albums/:curatorId/palette`          | Sets a hand-edited palette. Marks `handEdited: true`.              |
| POST   | `/api/albums/:curatorId/palette/reset`    | Drops the hand-edit; next generate will replace it.                |
| POST   | `/api/albums/:curatorId/pattern`          | Update pattern type and params.                                    |
| POST   | `/api/batch/regenerate-palettes`          | Regenerate all non-hand-edited palettes. Streams progress via SSE. |

### Artwork

| Method | Path                                      | Purpose                                                                                        |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/albums/:curatorId/artwork`          | The current resolved artwork (jpg). Override wins if present.                                  |
| POST   | `/api/albums/:curatorId/artwork/override` | Multipart upload of a JPG. Overrides Spotify art. Automatically triggers palette regeneration. |
| DELETE | `/api/albums/:curatorId/artwork/override` | Remove override, revert to Spotify art. Regenerates palette.                                   |

### Prompts

| Method | Path                                           | Purpose                                                                                                                                                                  |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/albums/:curatorId/prompts/:type/redraft` | Regenerate a prompt. `type` is `video` or `cardArt`. Body: `{ template?: string }`.                                                                                      |
| POST   | `/api/albums/:curatorId/prompts/:type/copied`  | Marks a prompt as copied. For `video`, transitions from `awaiting_review` toward `awaiting_video`. For `cardArt`, marks the card side as "prompt ready to generate art." |
| GET    | `/api/prompt-templates/:type`                  | List of style templates for the given type.                                                                                                                              |
| POST   | `/api/prompt-templates/:type`                  | Save a new template. Body: `{ name, preamble, body }`.                                                                                                                   |

### Videos

| Method | Path                                  | Purpose                                                                                                                      |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/videos/upload`                  | Multipart upload. Body includes optional `curatorId` to attach immediately. Stores in `/incoming/` if no curatorId.          |
| GET    | `/api/incoming`                       | Lists files in `/incoming/` with thumbnails and inferred metadata.                                                           |
| POST   | `/api/albums/:curatorId/attach-video` | Body: `{ fileId }` — either an ID of a file already in `visualizers/`, or the filename of a file in `/incoming/` (moves it). |
| POST   | `/api/albums/:curatorId/detach-video` | Removes the visualizer reference. File stays on disk unless `?delete=1`.                                                     |

### Card art

| Method | Path                                     | Purpose                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/card-art/upload`                   | Multipart upload. Body includes optional `curatorId` to attach immediately. Stores in `/incoming/` if no curatorId. Validates image format (PNG or JPG) and reasonable dimensions (recommends 1050x600 landscape or 600x1050 portrait, but doesn't reject other sizes). |
| POST   | `/api/albums/:curatorId/attach-card-art` | Body: `{ fileId }`. Same shape as video attach.                                                                                                                                                                                                                         |
| POST   | `/api/albums/:curatorId/detach-card-art` | Removes the card art reference. File stays on disk unless `?delete=1`.                                                                                                                                                                                                  |
| GET    | `/api/albums/:curatorId/card-art`        | Serves the current card art image.                                                                                                                                                                                                                                      |
| GET    | `/api/albums/:curatorId/card-art/print`  | Serves a print-optimized version (300 DPI, standard business-card dimensions) suitable for sending to a printer.                                                                                                                                                        |

### Preview and verification

| Method | Path                                     | Purpose                                                                                                   |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/albums/:curatorId/preview`         | Serves the preview view — palette animating alongside the video, browser-rendered, no hardware.           |
| POST   | `/api/albums/:curatorId/preview/approve` | Marks preview as approved. Transitions state to `awaiting_tag_write`.                                     |
| POST   | `/api/albums/:curatorId/simulate-scan`   | Fires simulated scan to both Conductor and Backdrop for this album. Useful for pre-physical verification. |
| POST   | `/api/albums/:curatorId/verify-physical` | Marks the album as physically verified. Called from the UI after a real scan test.                        |

### Tag writing

| Method | Path                                 | Purpose                                                                                                                                            |
| ------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/albums/:curatorId/tag-payload` | Returns `{ payload: "curator:album:2k7bxq9m", qrDataUrl: "data:image/svg+xml;..." }`. Same payload written to both sleeve and card. UI shows both. |
| POST   | `/api/albums/:curatorId/tag-written` | Body: `{ object: "sleeve" \| "card", tagUid?: string }`. Marks the tag written for the specified physical object.                                  |

### Roadie (agent) endpoints

| Method | Path                          | Purpose                                             |
| ------ | ----------------------------- | --------------------------------------------------- |
| GET    | `/api/agent/status`           | Current activity, queue depth, recent activity log. |
| POST   | `/api/agent/retry/:curatorId` | Manually re-trigger a stuck or errored album.       |
| POST   | `/api/agent/pause`            | Stop processing new items.                          |
| POST   | `/api/agent/resume`           | Resume processing.                                  |

### Backdrop sync

| Method | Path                                  | Purpose                                                    |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| POST   | `/api/backdrop/sync`                  | Full library push.                                         |
| POST   | `/api/backdrop/push-album/:curatorId` | Single-album upsert. Auto-called on save.                  |
| POST   | `/api/backdrop/verify-sync`           | Compare Curator's library against Backdrop's; return diff. |
| POST   | `/api/backdrop/sync-media`            | Trigger rsync of video files.                              |

Backdrop URL and shared secret live in Curator's config:

```toml
[backdrop]
url = "http://backdrop.local:4740"
shared_secret = "..."
push_on_save = true
```

### Application settings

Curator holds application-level settings that affect the runtime services and pushes changes to them.

| Method | Path                            | Purpose                                                                                                                                                                                             |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings`                 | Returns current Curator settings.                                                                                                                                                                   |
| PUT    | `/api/settings`                 | Updates one or more settings. Any setting change that affects Conductor or Backdrop is automatically pushed to that service (e.g., listening-room changes push to Conductor's `PUT /api/settings`). |
| GET    | `/api/settings/available-rooms` | Proxies to Conductor's `/api/rooms` and returns the Hue rooms available to choose from as the listening room.                                                                                       |

Settings that live here:

- `listeningRoomId` — the Hue room Conductor drives when scan events arrive. Pushed to Conductor on change.
- Conductor URL + shared secret (mirror of what's in the TOML config; exposed for UI editing convenience)
- Backdrop URL + shared secret (same)
- Tag placement guide text — a reminder string like "back cover, upper-right" shown to the user during the tag write flow

## 9. Video workflow (mostly unchanged from prior spec)

Two entry points depending on how you like to work:

**A. Drag-and-drop in the UI.** From the album detail's video section, drag a video file. It uploads, gets a thumbnail generated, and is attached to that album.

**B. Bulk drop into `/incoming/`.** SFTP, network share, or file explorer drag. The watched folder picks up new files, generates thumbnails, and shows them in the Incoming screen. Click an unclaimed video, search the album it belongs to, click "attach." Handles the "I generated a batch of ten and don't remember which is which" case.

**Video processing on ingest:**

1. Probe with `ffprobe` — get duration, resolution, codec, container.
2. Validate: H.264 in MP4 required (or H.265 in MP4 if targeting Pi 5). Reject with a clear error otherwise.
3. Generate thumbnails — first frame and midpoint, 320px wide, jpg.
4. Move to final location if attaching now, or leave in `/incoming/`.

## 10. UI screens

The primary UI is queue-shaped, per the album onboarding workflow's "you never feel behind" property.

### Queue view (default screen)

Sections in order of user attention:

**Needs you right now** — grouped by which step is next:

- Awaiting review (Roadie done, needs your sign-off + prompt copy)
- Awaiting video (video generation in progress)
- Awaiting preview (video attached, needs sign-off)
- Awaiting tag write (needs sticker)
- Awaiting verification (needs physical scan)

Each row: cover art thumbnail, title/artist, timestamp of state entry, one big next-action button.

**Roadie is on it** — currently-processing items (usually 0–3).

**Needs your attention** — errored / needs_manual with cause and retry.

**Done** — verified albums, collapsed by default.

Filters at top; search by title/artist. Batch actions in a menu.

The browser tab title carries the count of "needs you right now" — the number that answers "should I sit down now?"

### Add album

Simple, focused screen. Three modes as tabs:

_Spotify search_ — text box with debounced autocomplete against Spotify. Grid of results with cover art. Click to preview metadata + click again to add. Handles most cases.

_Paste URI_ — textarea accepting one URI per line. Add-multiple button that submits each one to `/api/albums/batch`. For the "I have a list ready" case.

_Manual entry_ — form with title, artist, year, optional genres, and required art upload. Creates an album with `metadata.source = "manual"`. No Spotify data.

### Album detail (session-shaped, per onboarding workflow)

Two columns:

_Left, fixed_ — art (large), metadata, state stepper, session actions (pause, delete, jump back to previous step).

_Right, scrolling_ — sections in the order of the workflow:

- **Palette** — swatches + editor + role dropdowns + template dropdown + "reset to auto"
- **Pattern** — type + params
- **Video prompt** — generated text in code block + Copy Prompt + Regenerate + template selector + "Mark as copied" button
- **Video** — drop zone or attached preview + Detach + Replace
- **Card art prompt** — generated text + Copy Prompt + Regenerate + template selector (independent from video prompt template)
- **Card art** — drop zone or attached preview + Detach + Replace + "Download print version" button
- **Preview** — combined palette + video (see below)
- **Tag** — URI + QR + placement guide + Mark as written (with separate sleeve/card toggles)
- **Verify** — Simulate scan + Verify physical

Completed sections collapse to one-line summary. Current section expanded. Auto-save on edit. Card art sections stay accessible even after `verified` since a card can be added at any time.

### Preview

The confidence checkpoint. Full-screen (or modal from album detail):

- Video plays in center at moderate size
- Around/beside it, palette animates as CSS driven by the same pattern the runtime will use
- Big **Looks good** button (transitions to next state)
- **Something's off** button (jump back to palette or video edit without leaving)

No hardware required. Catches most "this doesn't feel like the album" issues before you touch a sleeve.

### Incoming

List of files in `/incoming/` with thumbnails, filenames, durations. Search-then-attach flow. Delete for junk.

### Batch progress

Slide-over panel when a batch operation runs. SSE-backed progress. Cancelable.

### Settings

Simple form-based screen accessible from a header link or a corner menu. Sections:

- **Listening room** — dropdown of Hue rooms (fetched from `/api/settings/available-rooms`, which proxies to Conductor). Changing the selection pushes to Conductor via `PUT /api/settings`. Shows current selection prominently — this is the setting most likely to change.
- **Service URLs** — Conductor URL, Backdrop URL, plus their shared secrets. Editable; changes update the TOML config on disk. Test-connection buttons for each service that fire a lightweight probe (`GET /api/bridge/status` on Conductor, `/healthz` on Backdrop) and report success/failure.
- **Tag placement guide** — a text field for the placement reminder shown during tag write ("back cover, upper-right corner, 25mm round"). Just a string; whatever helps you stay consistent.

Save happens on edit (debounced). Listening room push to Conductor happens synchronously — if the push fails, the setting change is rolled back and the user sees a clear error.

### Roadie activity (compact strip at the bottom of most screens)

Small, persistent: "Roadie: working on Kind of Blue (generating palette)" or "Roadie: idle, queue empty." Clickable → full activity log.

## 11. Development milestones

Each ends in a demoable state.

1. **Basic asset store scaffolding.** Read/write JSON files, serve via API. Success: create a stub asset file by hand, see it come back from `/api/albums/:curatorId`.
2. **Add album — manual mode.** Just the manual entry path (no Spotify yet). Success: fill out a form, see a new asset file with a curatorId.
3. **Spotify integration.** Add via Spotify URI, fetch metadata + art. Success: paste a URI, see metadata populated and art on disk.
4. **Spotify search UI.** The autocomplete search box. Success: type "Purple Rain," see results, click to add.
5. **Roadie skeleton.** Background worker + state machine + persistence. No external calls yet — mocked sub-steps. Success: add an album, watch state advance through mocked steps in test.
6. **Wire Roadie to Palette Press and Spotify.** Success: add a real album, Roadie completes to `awaiting_review` with real palette and metadata.
7. **Prompt drafting.** Template system + prompt generation. Success: `awaiting_review` state includes a generated prompt visible in the UI.
8. **Queue view UI.** The primary screen. Success: add 10 albums, watch them flow through the queue view as Roadie processes them.
9. **Album detail — session shape.** The right-column workflow view. Success: click into an album from the queue, see current state highlighted, complete steps in order.
10. **Preview view.** Palette + video combined preview. Success: attach a video to a Roadie-completed album, see the preview render correctly.
11. **Video upload + attachment.** Drag-and-drop + validation + thumbnails. Success: attach a video, see it in the detail view.
12. **Tag payload UI + write flow.** URI, QR, mark-written. Success: write your first NFC sticker end-to-end.
13. **Simulate scan endpoint.** Fires to Conductor and Backdrop. Success: click "Simulate scan," lights change in the other room.
14. **Backdrop sync (library + rsync trigger).** Automatic on save + manual buttons. Success: an album completed in Curator plays through the runtime.
15. **Override art support.** Upload replaces Spotify art, palette regenerates. Success: replace an ugly Spotify cover with a better scan, palette updates.
16. **Roadie retry + failure classes.** Graceful degradation, retry UI. Success: add a bogus URI, land at `needs_manual` with clear reason and retry button.
17. **Batch add + batch regenerate.** Paste 20 URIs at once; regenerate all palettes after a Palette Press upgrade. Success: 20 albums queued in one action; all palettes regenerate cleanly.
18. **Backup on write + status derivation polish.** `.bak` files, issue list, next-step surfacing. Success: fat-finger a palette edit, restore from `.bak`.

## 12. Known gotchas

- **curatorId collisions.** `nanoid` at 8 chars from base32 gives ~1 in a million per pair for reasonable collection sizes — effectively zero. But the code should still handle the collision case (generate a new one and try again) rather than assume uniqueness. This is a 3-line addition; do it in the constructor.
- **Album re-add.** User adds the same Spotify URI twice. Detect on add via `metadata.spotifyUri` lookup — reject with 409 and surface the existing curatorId. Prevents accidental duplicates.
- **Spotify search rate limits.** Autocomplete makes many requests. Debounce heavily (300ms) and cache recent queries. Client-side is enough; no need for server-side caching yet.
- **Art override triggers palette regen.** If a user has hand-edited the palette and then overrides art, options are (a) auto-regen and lose the hand edit, (b) leave the hand edit alone despite new art, (c) ask. The app asks ("You have a hand-edited palette. Regenerate with new art?"). Costs one dialog; prevents surprising data loss.
- **Filesystem paths on Windows.** Store paths as POSIX in JSON; convert at read time. Same guidance as previous spec.
- **Videos in git.** Don't put `/media/` in git. `/album-assets/` yes.
- **The `handEdited` semantics.** Hand-edited palette + Palette Press version bump. If you want to retry the algorithm on this album, "reset to auto" is explicit. Never overwrite a hand-edit without user action.
- **Roadie state races.** If a human edits a palette while Roadie is processing that album, Roadie should hold a per-album lock. Single-threaded Roadie makes this easy: only one album has an active lock at a time.
- **The `tag.payload` value drift.** If a user renames a curatorId (they shouldn't, but if the code ever grows a rename feature), the physical NFC sticker still says the old ID. Prevent renames. If ever needed, "rename" is really "delete + re-add with new ID" and the sticker must be rewritten physically.
- **Manual entries and Backdrop's library.** Manual albums have no Spotify art URL. Backdrop's library entry uses the local artwork path, which Backdrop needs synced to its SD card. Include `media/artwork/` in the rsync targets, not just `visualizers/`.
