# Curator — Technical Spec

_The tool that curates your collection's presentation assets. Standalone admin app; source of truth for what's in the experience._

## 1. Purpose

A local admin app that is the source of truth for **which albums are in the experience**. Curator owns the album inventory, coordinates the flow of getting each album from "just added" to "fully working on a physical scan," and hosts Roadie (the background agent that automates every step it can).

The album identifier used throughout the system is **`curator:album:<curatorId>`** — an internal identifier owned by Curator. Spotify URIs, when available, are stored as metadata on the album record and used for auto-fetching art and metadata, but they're never the runtime identifier. This means albums that don't exist on Spotify (rare pressings, private releases) work exactly like albums that do.

## 2. Success criteria

**Add 10 albums via the Add screen. Walk away. Come back to a queue of albums in "awaiting your review" state, each with art and palette ready. Work through each one in a session (per the album onboarding workflow) — drafting prompts for the ones that need them, and going straight to attaching for the ones whose artifacts you already have. End with 10 fully-configured, playable albums.**

> **2026-07-25 ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)):** this previously
> promised prompts ready on arrival too. Drafting is now invoked rather than pipelined — it costs two
> Gemini calls per album and was being spent on every album, including ones whose video and card art
> the user already had. The walk-away property is unchanged for art and palette; prompts are one
> click away in the workstation that uses them.

The queue-first workflow — Roadie does everything it can, humans work through what's left — is what makes 500 albums a realistic target instead of a fantasy.

## 3. Scope

### In scope

- Album inventory management: add via Spotify search, paste URI, paste batch, or fully manual entry
- Roadie: background agent processing newly-added albums through pre-video work (specified in its own doc)
- Palette generation via Palette Press library; hand-editing per album; batch regeneration
- Grounded, LLM-authored prompts (Gemini) with template fallback; **opt-in** artifact generation — card art (Nano Banana) + visualizer clips (Omni Flash), off by default (ADRs 0009–0012)
- Video upload and attachment (drag-and-drop, `/incoming/` watch)
- Video thumbnail generation and format validation
- Album-assets store on disk (JSON, human-readable, git-friendly)
- Media store on disk for video files, artwork, thumbnails (out of git)
- Queue-view UI as the primary screen
- Album detail UI (a **workbench** — five workstations behind a rail, nothing gated by state; [ADR 0026](../adrs/0026-album-detail-is-a-workbench.md))
- Add album UI (search, paste, manual)
- In-app **bench preview** (sleeve + palette animating alongside video, plus desk audio on the workstation's own Spotify client; no hardware touched — [ADR 0028](../adrs/0028-preview-bench-and-room-modes.md), [ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md))
- Tag payload UI (URI + QR + mark-as-written)
- **Room rehearsal** against the real runtime services (Conductor + Backdrop + Amp), behind an explicit room-arm switch ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md))
- Backdrop sync (library metadata push + media rsync trigger)
- Override art support (upload your own JPG when Spotify's isn't right)
- Application settings management (listening room, service URLs) with push-on-change to Conductor and Backdrop

### Out of scope

- NFC reader integration (phone handles tag writing)
- Runtime playback (Conductor and Backdrop own that)
- Video transcoding (validate-and-move only; reject bad formats with a clear error)
- Multi-user or cloud sync
- **Automatic** audio-feature fetching (Spotify Audio Features deprecated). Palette Press selects patterns from palette energy instead ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)); hand-authored `audioFeatures` refine it
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
- ~~**File watching**: `chokidar` for the `/incoming/` folder~~ — _never adopted; there is no watcher (2026-07-25, §9)_
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
  // Discogs-sourced albums (issue #24 / ADR 0017) carry instead:
  //   "source": "discogs",
  //   "discogsReleaseId": 249504,
  //   "discogsUri": "discogs:release:249504",
  //   "discogsArtUrl": "https://i.discogs.com/..."

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

- `metadata.source` distinguishes `"spotify"`, `"discogs"`, and `"manual"` — manual albums lack the provider URIs and have artwork sitting only in `media/artwork-overrides/`; Discogs albums (issue #24 / [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)) carry `discogsReleaseId` / `discogsUri` / `discogsArtUrl` in place of the `spotify*` fields.
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

`GET /healthz` is unauthenticated and returns 200 once the server is up — the desktop shell polls it
to know when Curator is ready to show ([ADR 0008](../adrs/0008-desktop-app-supervises-services.md)).

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
>
> **Discogs add (issue #24 / [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)):**
> a JSON body `{ releaseId, title?, artist?, year?, genres?, coverImage? }` (the release id from the
> collection browser) writes a `fresh` `source: "discogs"` asset, dedupes on the Discogs release id
> (**409**), and hands off to Roadie (which fetches the authoritative release detail + cover image).
> `GET /api/discogs/collection?page=&perPage=` backs the browser (paginated), and
> `GET`/`PUT /api/settings/discogs` store the personal access token **and/or the OAuth consumer creds**.
> All Discogs routes **503** when neither a token nor a connected OAuth session is configured.
>
> **Auth (issue #24 / #59):** a **personal access token** (the simple default) _or_ full **OAuth 1.0a**
> "log in with Discogs" (3-legged, PLAINTEXT-signed — [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)).
> The OAuth routes mirror Spotify's: `GET /api/discogs/auth/login` → `{ authorizeUrl }`;
> `GET /api/discogs/auth/callback?oauth_token=&oauth_verifier=` (browser-facing, HTML);
> `GET /api/discogs/auth/status` → `{ connected, username? }`;
> `POST /api/discogs/auth/disconnect`. A connected session signs each API request behind the same
> `DiscogsClient`; absent one, the personal token is used. OAuth routes **503** unless consumer creds
> are configured.

| Method | Path                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`               | Liveness, unauthenticated: `{ ok, albums, spotify, discogs, gemini, roadie }`. The desktop shell polls it to know when Curator is ready to show ([ADR 0008](../adrs/0008-desktop-app-supervises-services.md)). Described in the prose above but missing from this table until 2026-07-27 ([issue #106](https://github.com/dylanleatham/Marquee/issues/106)).                                                                                                                                                                                               |
| POST   | `/api/albums`            | Add an album. Body: `{ mode: "spotify" \| "manual", spotifyUri?, searchQuery?, manualMetadata? }`. Returns `{ curatorId }`. Enqueues in Roadie for auto-processing.                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/api/albums/batch`      | Add multiple albums. Body: `{ items: [...] }` — each item a bare `spotify:album:…` line or `{ spotifyUri \| spotifyId }`. Returns a **per-item report**: `{ added, duplicate, invalid, failed, curatorIds, items: [{ index, input, status, curatorId?, error? }] }`. Always `200` for a well-formed request (partial success is normal); `400` only for a malformed envelope — not an array, empty, or over the 500-item cap. Each added item enqueues separately. _(Built 2026-07-25, [issue #104](https://github.com/dylanleatham/Marquee/issues/104).)_ |
| GET    | `/api/albums`            | List all albums. Query params for filtering: `?state=awaiting_review`, `?query=text`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/api/albums/:curatorId` | Full asset file + derived status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DELETE | `/api/albums/:curatorId` | Remove from Curator. Query params: `?deleteMedia=1` also removes associated video and art files. Does NOT untag; that's a physical action you have to do yourself.                                                                                                                                                                                                                                                                                                                                                                                         |

### Discogs (collection browse + auth)

> Documented in prose above ([ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md) / issues #24, #59);
> tabled here 2026-07-25 so the routes are findable. All **503** when neither a personal token nor a
> connected OAuth session is configured.

| Method | Path                           | Purpose                                                                                       |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| GET    | `/api/discogs/collection`      | The user's Discogs collection, paginated (`?page=&perPage=`). Backs the Add screen's browser. |
| GET    | `/api/discogs/auth/login`      | Start the 3-legged OAuth 1.0a login. Returns `{ authorizeUrl }`.                              |
| GET    | `/api/discogs/auth/callback`   | Browser-facing callback; exchanges the verifier and persists the session. Responds with HTML. |
| GET    | `/api/discogs/auth/status`     | `{ connected, username? }`.                                                                   |
| POST   | `/api/discogs/auth/disconnect` | Forget the session.                                                                           |

### Spotify search (for the Add screen)

| Method | Path                            | Purpose                                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/spotify/search-albums?q=` | Autocomplete album search. Returns candidates with cover art thumbnails. |
| GET    | `/api/spotify/album/:spotifyId` | Preview one album's Spotify metadata before adding.                      |

### Spotify user login (Authorization Code + PKCE)

> **2026-07-19 ([ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md), issue #23):** logging in as a
> real Spotify user routes calls through the user session (personalized search now; the foundation
> for **Spotify Connect playback** later). Curator serves the loopback OAuth callback on its own
> port; the desktop shell opens the authorize URL in the system browser. Client-credentials stays the
> **fallback** for catalog reads when no user is connected — so search/add work with no login. The
> refresh token is persisted (plaintext) in `spotify-tokens.json` in the data dir (**not**
> `settings.json`); Connect/Disconnect take effect immediately (no restart). `login` / `callback` /
> `disconnect` **503** when Spotify isn't configured; `status` returns `{ connected: false }` (200)
> so the UI can poll it unconditionally.

| Method | Path                           | Purpose                                                                                                                                                        |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/spotify/auth/login`      | Start a login. Returns `{ authorizeUrl }` for the UI to open (state + PKCE held server-side).                                                                  |
| GET    | `/api/spotify/auth/callback`   | The registered loopback redirect target. Validates `state`, exchanges the code (PKCE) for tokens, persists the refresh token. Responds with a small HTML page. |
| GET    | `/api/spotify/auth/status`     | `{ connected, scope? }` — whether a user session exists and the scopes granted.                                                                                |
| POST   | `/api/spotify/auth/disconnect` | Forget the user session (clears the refresh token). Returns `{ ok }`.                                                                                          |

### Queue (primary UI backing)

> **2026-07-13 ([ADR 0004](../adrs/0004-curator-agent-endpoint-namespace.md)):** the queue endpoints
> live under `/api/agent/*` (matching roadie-spec §10 and the Roadie controls below), not the
> top-level `/api/queue` this table originally listed. Response shapes are unchanged.

| Method | Path                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/agent/queue`             | Returns albums grouped by human-facing state. Shape: `{ awaiting_review: [], awaiting_video: [], awaiting_preview: [], awaiting_tag_write: [], awaiting_verify: [], processing: [], errored: [], needs_manual: [], done_recently: [] }`. Each entry: minimal album summary (curatorId, art thumbnail, title/artist, entered-state timestamp).                                                 |
| GET    | `/api/albums/:curatorId/peers` | Where this album sits among the others at the same state, and who is either side: `{ bucket, position, total, prev, next }` ([issue #94](https://github.com/dylanleatham/Marquee/issues/94)). Shares `buildQueue`'s bucketing, so a peer walk and the queue can never disagree about who sits together. Does **not** wrap — `prev`/`next` are `null` at the ends. `404` for an unknown album. |
| GET    | `/api/agent/queue/counts`      | Per-bucket counts + the "needs you right now" total. Backs the header count (and optionally the taskbar/dock badge) — not a tab title; there is no tab.                                                                                                                                                                                                                                       |

### Palettes

| Method   | Path                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/api/albums/:curatorId/palette/generate` | Runs Palette Press. Skips if hand-edited unless `?force=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PUT      | `/api/albums/:curatorId/palette`          | Sets a hand-edited palette. Marks `handEdited: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST     | `/api/albums/:curatorId/palette/reset`    | Drops the hand-edit; next generate will replace it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PUT      | `/api/albums/:curatorId/streaming-effect` | Body `{ effect: "aurora" \| "shimmer" \| "wave" \| null }`. Opt this album into an Entertainment streaming effect, or clear it with `null` ([ADR 0035](../adrs/0035-streaming-effect-is-a-per-album-opt-in.md)). A switch, **not** a pattern editor: the derived `pattern` is never written, and is exactly what plays on a room with no entertainment area. `409` while Roadie is processing; Optional `params` tunes that effect's own knobs ([ADR 0036](../adrs/0036-streaming-effect-params-are-tunable.md)), validated against `STREAM_PARAM_SPECS`; omitted leaves existing tuning alone, `{}` resets to defaults, and switching effects clears it. `400` on an unknown effect or an out-of-range/foreign knob. |
| POST     | `/api/albums/:curatorId/palette/feeling`  | Propose colours from how the album **sounds** ([ADR 0030](../adrs/0030-palette-from-album-feeling.md)). Two grounded Gemini calls; returns `{ candidates: { rationale, cover, feeling, blend } }` and **applies nothing** — the palette in force is untouched until you choose. `400` without a Gemini key or before a cover palette exists, `409` while Roadie is processing. Invoked only (ADR 0027): never by the pipeline, never by a sweep.                                                                                                                                                                                                                                                                      |
| POST     | `/api/albums/:curatorId/palette/choose`   | Apply one of the offered palettes. Body `{ source: "cover" \| "feeling" \| "blend" }`. `cover` re-extracts and clears the protection — the true undo; the other two take the stored candidate, set `palette.source`, and set `handEdited` so the library sweep leaves them alone. Motion is re-derived from whichever palette wins ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)). `400` on an unknown source or with no candidates yet.                                                                                                                                                                                                                                                                 |
| ~~POST~~ | ~~`/api/albums/:curatorId/pattern`~~      | **Never implemented; superseded 2026-07-25, formally dropped 2026-07-26.** Pattern is derived, not hand-set — from palette energy ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)) running on whichever palette is in force. [ADR 0030](../adrs/0030-palette-from-album-feeling.md) settles it: the answer to "the motion doesn't suit this record" is to change where the _colours_ come from, not to hand-tune a `params` blob.                                                                                                                                                                                                                                                                          |
| POST     | `/api/batch/regenerate-palettes`          | Regenerate all non-hand-edited palettes. Runs as a **library-scoped background job** ([ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md)): returns `202` with the job as the body (as every job-starting route does) and no `curatorId` on it; poll `GET /api/jobs/:id`, stop with `POST /api/jobs/:id/cancel`, list with `GET /api/jobs?kind=paletteBatch`. `?force=1` includes hand-edited palettes. Hand-edited, still-processing and art-less albums are **skipped and reported**, not failed; one album's failure doesn't end the sweep. A palette chosen from the album's feeling counts as hand-edited here, so a sweep never reverts it (ADR 0030). `503` without a palette generator.              |

> **2026-07-25 (issue #104):** the batch row previously read _"~~Streams progress via SSE~~."_ That
> predated the background-job manager ([ADR 0018](../adrs/0018-generation-runs-as-background-jobs.md)),
> which already does progress, cancel and restart-persistence for the generation actions. Batch regen
> became a **job kind** on that machinery instead of a second transport — rationale and consequences in
> [ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md). No SSE endpoint exists in Curator.

### Artwork

| Method | Path                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/albums/:curatorId/artwork`          | The current resolved artwork (jpg). Override wins if present.                                                                                                                                                                                                                                                                                                                   |
| POST   | `/api/albums/:curatorId/artwork/override` | Multipart upload of a PNG or JPG (field `file`). Becomes the album's active cover — palette, card-art and video generation all derive from it. `regeneratePalette` (form field) decides the palette: it defaults to **true**, except when the palette is hand-edited, where the default is to keep the edit (§12). `404` unknown album, `400` no file or an unsupported format. |
| DELETE | `/api/albums/:curatorId/artwork/override` | Drop the override and revert to the fetched cover, re-deriving the palette from it (`?regeneratePalette=false` keeps the current one). The override file is deleted; the fetched cover was never touched, so this reverts rather than re-downloads. `404` when no override is active.                                                                                           |

### Prompts

| Method   | Path                                                 | Purpose                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/api/albums/:curatorId/prompts/:type/draft`         | **Draft this prompt type on request** — the lazy replacement for Roadie's old `drafting_prompts` step ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)). Prefers the grounded Gemini path, silently falls back to templates, so it cannot fail on a missing key. Drafts **only** the requested type. `400` if no palette yet. |
| POST     | `/api/albums/:curatorId/prompts/:type/select`        | Choose which of the five drafted variants is active (the one Copy hands off and generation uses). Body: `{ index }`.                                                                                                                                                                                                                          |
| POST     | `/api/albums/:curatorId/prompts/:type/regenerate-ai` | Redraft as a fresh grounded LLM variant set. Unlike `draft` there is **no template fallback** — a failure surfaces and the existing draft is left untouched. `400` without a Gemini key.                                                                                                                                                      |
| POST     | `/api/albums/:curatorId/prompts/:type/copied`        | Marks a prompt as copied — sent by the UI's Copy Prompt button itself (ADR 0005). For `video`, transitions from `awaiting_review` toward `awaiting_video`. For `cardArt`, marks the card side as "prompt ready to generate art."                                                                                                              |
| ~~GET~~  | ~~`/api/prompt-templates/:type`~~                    | **Never implemented; superseded 2026-07-25.** A user-authored template registry was overtaken by the five fixed metaprompt angles ([ADRs 0021](../adrs/0021-card-art-five-option-prompt-strategy.md) / [0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md)). The remaining style templates are a fixed client-side list.     |
| ~~POST~~ | ~~`/api/prompt-templates/:type`~~                    | **Never implemented; superseded 2026-07-25.** See above.                                                                                                                                                                                                                                                                                      |

### Videos

> **Amended 2026-07-18 by [ADR 0011](../adrs/0011-auto-generate-visualizer-clips.md):** the
> visualizer can be **generated** as a set of short clips (one per drafted video prompt variant,
> image-to-video off the album cover, Omni Flash) — see the `video/generate` and `video/clip/:index`
> rows. Clips are not promoted to the single attached `visualizer` automatically. Requires a Gemini
> key (Omni Flash, ADR 0013).
>
> **Amended 2026-07-21 by the [ADR 0011 addendum](../adrs/0011-auto-generate-visualizer-clips.md) (issue #29):**
> the clips can be **spliced into one loop in-app** (`video/splice` row) — reorder/deselect, then
> concat + attach — so they no longer have to leave Curator. Downloading a clip to edit externally +
> manual upload remain the override.
>
> **Amended 2026-07-23 by [ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md):**
> the LLM video prompt now defaults to the `narrative` five fixed-angle style (photo/abstract kept as
> alternates), and the detail UI surfaces all five prompts, each individually copyable and generatable
> via the new `video/generate/:index` row below (one clip from one prompt, a background job keyed on
> the prompt index). The whole-set `video/generate` job is unchanged.

| Method | Path                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/videos/upload`                                 | Multipart upload. Body includes optional `curatorId` to attach immediately. Stores in `/incoming/` if no curatorId. Over the upload ceiling → `413` (§9).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/api/albums/:curatorId/attach-video`                | Body: `{ fileId }` — either an ID of a file already in `visualizers/`, or the filename of a file in `/incoming/` (moves it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/api/albums/:curatorId/detach-video`                | Removes the visualizer reference. File stays on disk unless `?delete=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/api/albums/:curatorId/video/generate`              | Start a clip-set generation — one image-to-video clip per drafted video prompt variant, off the cover (Omni Flash). Runs as a **background job** (issue #30 / [ADR 0018](../adrs/0018-generation-runs-as-background-jobs.md)): returns `202 { id, status, progress, … }`; poll `GET /api/jobs/:id`. On success stores `videoClips`. `400` (immediate precheck) if no Gemini key, generation off (opt-in, ADR 0012), no video prompt, or no cover art; whole-batch upstream failure → the **job** ends `failed` (partial success kept). Long-running (ADRs 0011/0013).                               |
| POST   | `/api/albums/:curatorId/video/generate/:index`       | Generate a **single** clip from one drafted video prompt variant, off the cover (Omni Flash). Also a **background job** (`202 { id, index, … }`; poll `GET /api/jobs/:id`) but keyed on the prompt index, so a per-clip run and the set (or another index) don't shadow each other. On success the clip is merged into `videoClips` (replaces its index, keeps siblings). Same opt-in precheck as the set → `400`; an out-of-range index → `400`. Drives the per-prompt "Generate clip" buttons ([ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md)).                         |
| GET    | `/api/jobs/:id`                                      | Poll a generation job — `{ id, kind, curatorId?, status: running\|done\|failed\|cancelled, progress: {done,total}, result?, error? }`. `404` once unknown/expired (ADR 0018). Jobs persist across a restart; one left running when the process died is restored as `failed` "interrupted" (issue #57). `curatorId` is **absent on a library-scoped job** — a batch sweep belongs to no one album ([ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md)).                                                                                                                                    |
| POST   | `/api/jobs/:id/cancel`                               | Cancel an in-flight generation job — aborts the runner (stopping the Gemini fetch) and marks it `cancelled`. Idempotent: a terminal job returns unchanged, unknown → `404` (issue #57).                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/api/albums/:curatorId/jobs`                        | An album's active + recent generation jobs (optional `?kind=video\|cardArt`) — lets the UI re-attach to a running job after a reload (ADR 0018). Library-scoped jobs never appear here.                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/api/jobs?kind=paletteBatch`                        | Active + recent **library-scoped** jobs of a kind, newest first — how the batch panel re-attaches to a sweep after a reload. `kind` is required and must name a library kind; anything else → `400` (ADR 0029).                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/api/albums/:curatorId/video`                       | Serves the attached visualizer (`video/mp4`). Backs the preview player. `404` until one is attached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/albums/:curatorId/thumbnail`                   | Serves the visualizer's poster frame (jpg), used as the player poster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/api/albums/:curatorId/video/clip/:index`           | Serves a generated clip (`?download=1` for a named download).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/api/albums/:curatorId/video/clip/:index/thumbnail` | Serves the clip's poster frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/api/albums/:curatorId/video/splice`                | Splice the generated clips into one looping MP4 in-app (issue #29 / [ADR 0011 addendum](../adrs/0011-auto-generate-visualizer-clips.md)) and attach it as the visualizer. Body: `{ order?: number[], crossfadeSec?: number }` — clip indices to join, in order (default: all); a positive bounded `crossfadeSec` blends the seams with `xfade` instead of a hard cut (issue #56, default plain concat). Mismatched clip dimensions are normalized to a common frame. ffmpeg-concats (re-encoded H.264), ingests via the normal path, advances to `awaiting_preview`. `400` if no clips / bad order. |

### Card art

> **Implementation notes (2026-07-13, build step 7):** two intentional gaps against the tables in
> this section. (1) `attach-video` / `attach-card-art` currently claim a file from `/incoming/`
> only — re-attaching a file that's already in `visualizers/`/`card-art/` isn't wired yet (the
> drag-drop and `/incoming/` flows cover the real cases). (2) `/card-art/print` serves the stored
> image verbatim; the 300-DPI print render is deferred until Curator gains an image pipeline (see
> the curator README). Video ingest validation + thumbnails require `ffmpeg`.
>
> **Amended 2026-07-18 by [ADR 0010](../adrs/0010-auto-card-art-generation-candidate-set.md):** card
> art can now be **generated** as a set of candidates (one image per drafted card-art prompt variant,
> Nano Banana) that the human picks from — see the `card-art/generate`, `card-art/select`, and
> `card-art/candidate/:index` rows below. The single attached `cardArt` contract is unchanged;
> generation just feeds it. Requires a Gemini key (no fallback).
>
> **Amended 2026-07-23 by [ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md):** the
> card-art metaprompt now defines **five fixed-angle options**, and the detail UI surfaces all five
> prompts — each individually copyable and generatable via the new `card-art/generate/:index` row
> below (one image from one prompt, synchronous). The whole-set `card-art/generate` job is unchanged.
>
> **Amended 2026-07-26 by [ADR 0031](../adrs/0031-card-art-cover-reference-image.md):** both generate
> routes send the album cover as a **reference image** alongside the prompt — but only for variants the
> drafter marked `coverAnchored` (Option 1, Cover Reimagining). The options that deliberately depart
> from the sleeve stay text-only, so the set keeps its spread. The cover is resolved through the same
> path as video generation, so a manual artwork override is honored. Unlike video, a **missing cover is
> not an error**: anchored prompts fall back to text-only and generation proceeds.
>
> **Amended 2026-07-27 by [ADR 0032](../adrs/0032-card-art-refusal-drops-the-cover-reference.md):** the
> reference is **best-effort**. Gemini refused a cover-anchored prompt with `IMAGE_RECITATION` — a
> recitation refusal, i.e. declining to reproduce the copyrighted sleeve we attached (issue #152). Both
> generate routes now **retry once without the reference** when a refused variant carried one; a
> candidate that only generated that way is marked `coverReferenceDropped` (it no longer closely
> re-renders the sleeve). A variant refused on both attempts is recorded in `cardArtRefusals`
> (index, nudge, Gemini's verbatim reason, whether the retry ran) instead of vanishing from the
> gallery — including when _every_ variant is refused. Non-refusal errors (5xx, timeout, cancel) are
> not retried.

| Method | Path                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/card-art/upload`                             | Multipart upload. Body includes optional `curatorId` to attach immediately. Stores in `/incoming/` if no curatorId. Validates image format (PNG or JPG) and reasonable dimensions (recommends 1050x600 landscape or 600x1050 portrait, but doesn't reject other sizes). Over the upload ceiling → `413` (§9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/api/albums/:curatorId/attach-card-art`           | Body: `{ fileId }`. Same shape as video attach.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/albums/:curatorId/detach-card-art`           | Removes the card art reference. File stays on disk unless `?delete=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/api/albums/:curatorId/card-art/generate`         | Start a candidate-set generation — one image per drafted card-art prompt variant (Nano Banana; the album cover is attached as a reference image for `coverAnchored` variants only, [ADR 0031](../adrs/0031-card-art-cover-reference-image.md); a refused variant retries once without it, [ADR 0032](../adrs/0032-card-art-refusal-drops-the-cover-reference.md)). Runs as a **background job** (issue #30 / [ADR 0018](../adrs/0018-generation-runs-as-background-jobs.md)): returns `202 { id, status, progress, … }`; poll `GET /api/jobs/:id`. On success stores `cardArtCandidates`. `400` (immediate precheck) if no Gemini key, generation off (opt-in, ADR 0012), or no card-art prompt; whole-batch upstream failure → the **job** ends `failed` (partial success kept). (ADRs 0010/0018) |
| POST   | `/api/albums/:curatorId/card-art/generate/:index`  | Generate a **single** candidate from one drafted card-art prompt variant (Nano Banana; the cover is attached as a reference image if that variant is `coverAnchored`, [ADR 0031](../adrs/0031-card-art-cover-reference-image.md); a refused variant retries once without it, [ADR 0032](../adrs/0032-card-art-refusal-drops-the-cover-reference.md)). One bounded image call, so it's **synchronous**: `200 { cardArtCandidates }` with the new candidate merged in (replaces its index, keeps siblings). Same opt-in precheck as the set → `400`; an out-of-range index → `400`; upstream failure → `5xx`. Drives the per-prompt "Generate art" buttons ([ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md)).                                                                       |
| POST   | `/api/albums/:curatorId/card-art/select`           | Body: `{ index }`. Promotes a generated candidate to the attached card art (ADR 0010).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/api/albums/:curatorId/card-art/candidate/:index` | Serves a generated candidate image (before one is promoted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/api/albums/:curatorId/card-art`                  | Serves the current card art image.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/albums/:curatorId/card-art/print`            | Serves a print-optimized version (300 DPI, standard business-card dimensions) suitable for sending to a printer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Preview and verification

| Method | Path                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/albums/:curatorId/preview/reject`     | "Something's off" — steps the album back. Body: `{ to: "awaiting_review" \| "awaiting_video" }`.                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/albums/:curatorId/preview/approve`    | Marks preview as approved. Transitions state to `awaiting_tag_write`.                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/api/albums/:curatorId/simulate-scan`      | Fires a simulated scan to Conductor, Backdrop **and Amp** for this album — the complete room rehearsal, i.e. the real runtime path minus the physical tag ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md); Amp added 2026-07-25). Backs Preview's room mode, so it is gated on the room-arm switch.                                                                                                                       |
| POST   | `/api/albums/:curatorId/simulate-scan/stop` | Ends the rehearsal: a `stop` scan event to Conductor and Backdrop, plus Amp stop. Same per-leg reporting — a leg that is unconfigured, unreachable, **or explicitly ignored by the service** is reported, never fatal.                                                                                                                                                                                                              |
| POST   | `/api/albums/:curatorId/desk-audio`         | Bench preview's audio leg ([ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md), 2026-07-27): transfers Spotify Connect to the workstation's own desktop client and starts the album's `spotifyUri` there. Curator picks the device and only ever accepts a local `Computer` — the browser cannot name one, so bench can't reach a room speaker. Touches no hardware, so it is **not** gated on the room-arm switch. |
| DELETE | `/api/albums/:curatorId/desk-audio`         | Pauses desk audio. Already-paused is success. Both verbs answer `200` with a `reason` for anything that merely didn't happen (no Spotify session, no desktop client, not Premium, album not on Spotify, Spotify unreachable) — bench preview degrades to silent rather than failing.                                                                                                                                                |
| POST   | `/api/albums/:curatorId/verify-physical`    | Marks the album physically verified: records `verification.physicallyVerifiedAt` and transitions `awaiting_verify → verified` (issue #55). Fires the ★verify Backdrop reconcile (roadie-spec §6 / [ADR 0015](../adrs/0015-backdrop-sync-triggered-at-projection-changes.md)); Backdrop drift surfaces as `syncIssues`, non-blocking. `4xx` if not in `awaiting_verify`.                                                             |

> **A 2xx is not proof the room did anything** (2026-07-27, issue #164). Conductor accepts a scan it
> cannot act on and says so in the body — `202 {ok:true, action:"ignored", reason}` for
> `no listening room`, `album not synced` and `album not ready` ([ADR 0019](../adrs/0019-conductor-scan-reads-asset-store.md)).
> Curator reports any leg whose response carries `action:"ignored"` as `ok:false`, passing the
> service's own reason through, because a scan that was ignored is a leg that did not run. A service
> that simply accepts (Backdrop's `202 {accepted:true}`) has no `action` and stays a success. The
> shape is decoded once, by `scanIgnoredReason` in `@marquee/contracts`.

### Tag writing

| Method | Path                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/albums/:curatorId/tag-payload` | `{ object, payload, qrDataUrl }` — the exact string to burn into a sticker, plus an SVG QR of it. `?object=card` returns `curator:card:<id>`; the default sleeve returns any payload already recorded on the asset, else `curator:album:<id>`. Composed **server-side** so one source of truth backs the physical tag. _(2026-07-25: sleeve and card carry different URIs since [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md) — this row originally said "same payload" for both.)_ |
| POST   | `/api/albums/:curatorId/tag-written` | Body: `{ object: "sleeve" \| "card", tagUid?: string }`. Marks the tag written for the specified physical object (records `tag.<object>`, setting `tag.payload` if absent). Writing the **sleeve** (scanned on the stand) advances `awaiting_tag_write → awaiting_verify`; the **card** is independent bookkeeping and never transitions (issue #55).                                                                                                                                             |
| GET    | `/api/albums/:curatorId/tag.nfc`     | Download a Flipper Zero-writable `.nfc` for the album (NTAG213 with the `curator:album:<id>` NDEF pre-laid) — issue #67 / [ADR 0020](../adrs/0020-flipper-tag-authoring.md). Write it to a blank tag with the stock Flipper NFC app.                                                                                                                                                                                                                                                              |
| GET    | `/api/tags/pending`                  | `{ pending: [{ curatorId, name, artist }] }` — albums in `awaiting_tag_write`, so you know which `.nfc`s to fetch (issue #67).                                                                                                                                                                                                                                                                                                                                                                    |

### Roadie (agent) endpoints

| Method | Path                          | Purpose                                             |
| ------ | ----------------------------- | --------------------------------------------------- |
| GET    | `/api/agent/status`           | Current activity, queue depth, recent activity log. |
| POST   | `/api/agent/retry/:curatorId` | Manually re-trigger a stuck or errored album.       |
| POST   | `/api/agent/pause`            | Stop processing new items.                          |
| POST   | `/api/agent/resume`           | Resume processing.                                  |

### Demo / runtime preview

Proxies to Conductor so the browser never holds the shared secret (ADR 0007). Conductor URL + secret
live in Curator's config (`[conductor] url`, `shared_secret`, or env `CONDUCTOR_URL` /
`TRIGGER_SHARED_SECRET`).

| Method | Path               | Purpose                                                                                                                                                                                                                                                                                |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/demo/play`   | Body `{ curatorId }` → build the album's palette payload, `POST` it to Conductor's `/api/playback`.                                                                                                                                                                                    |
| POST   | `/api/demo/stop`   | Stop playback; Conductor restores the pre-demo lighting.                                                                                                                                                                                                                               |
| GET    | `/api/demo/rooms`  | Proxy Conductor's `/api/rooms` for the first-run room picker.                                                                                                                                                                                                                          |
| PUT    | `/api/demo/room`   | Body `{ roomId }` → set Conductor's listening room.                                                                                                                                                                                                                                    |
| GET    | `/api/demo/status` | `{ reachable, paired, listeningRoomId }` — Conductor-down is reported, not an error.                                                                                                                                                                                                   |
| POST   | `/api/demo/audio`  | Body `{ curatorId }` → proxy the album's `spotifyUri` to Amp's `POST /api/admin/play`, so a room rehearsal has sound ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)). Same secret-stays-server-side rationale as the rows above; Amp-unreachable is reported, not an error. |

### Backdrop sync

> **Implemented in build step 9 ([ADR 0015](../adrs/0015-backdrop-sync-triggered-at-projection-changes.md)).**
> Single-album pushes are **automatic**, fired at the action/route layer when an album's projection
> changes — a video attach (`/api/videos/upload`, `/api/albums/:id/attach-video`) upserts the entry,
> a detach (`/api/albums/:id/detach-video`) or album delete removes it. There is no separate
> `push-album` route (the earlier speculative name); the routes below are the _manual_ controls.
> Configured only when a Backdrop URL is set (`[backdrop] url` / env `BACKDROP_URL`); `mediaDir`
> roots the projection's `filePath`. Sync is best-effort — failures record on the album as
> `roadie.syncIssues`, never a state change.
>
> **`media_transfer` chooses how the video file itself reaches Backdrop** (2026-07-29,
> [ADR 0038](../adrs/0038-curator-pushes-media-over-http.md); env `BACKDROP_MEDIA_TRANSFER`):
>
> | Mode    | Meaning                                                                           |
> | ------- | --------------------------------------------------------------------------------- |
> | `none`  | Curator pushes metadata only; an out-of-band `rsync` moves the file. **Default.** |
> | `local` | Same machine — copied in-process into `media_dir`.                                |
> | `push`  | Streamed to Backdrop over HTTP (`PUT /api/media/:fileId`).                        |
>
> The former `sync_media_locally` boolean is still honoured and means `local`, so an existing config
> keeps its behaviour.
>
> **Whenever Curator moves the file itself** — `local` or `push`, i.e. any mode but `none` — it
> computes the visualizer's `sha256` and sends it as the entry's `contentHash`, and skips the
> transfer when Backdrop already reports that hash. It is not scoped to `push`: the check costs one
> hash (~0.5s for a 228 MB file, measured at 469 MB/s) and saves a copy either way, and scoping it
> would leave `local`-mode entries with no `contentHash` for `verify-sync` to compare. An entry with
> no `contentHash` (synced before this, or moved by rsync) is always re-sent — a needless transfer
> costs time, a wrongly-skipped one leaves a black screen. **A failed transfer fails the sync**;
> before this, sync reported success for pushing metadata whether or not the video ever arrived.
>
> **The transfer runs as a background job** (2026-07-29, issue #177). A video attach/upload/splice
> pushes the metadata on the request path and returns immediately with a `transferJobId`; the file
> follows as a `mediaTransfer` job, polled at `GET /api/albums/:curatorId/jobs?kind=mediaTransfer`
> and cancellable at `POST /api/jobs/:id/cancel`, with progress in **bytes sent / total**. Holding
> the request open instead meant a ~90-minute upload with no progress and no cancel, which reads as a
> frozen app.
>
> The ordering is load-bearing: the entry published on the request path carries **no `contentHash`**,
> because the bytes have not moved. An entry advertising a hash for a file Backdrop does not have
> would make skip-if-unchanged skip it forever — permanently and silently. The hash is written only
> after the transfer succeeds. Backdrop already tolerates an entry pointing at a missing file
> (backdrop-spec §10), so the intermediate state is legal.
>
> **`media_dir` is a path on Backdrop's host, and is taken verbatim** (2026-07-28, issue #166). It is
> resolved against Curator's own filesystem **only** when `sync_media_locally` is set — the one case
> where that host is this machine. In the split deployment resolving it is meaningless, and on Windows
> destructive: `resolve("/home/pi/…")` returns `C:\home\pi\…`, which reaches Backdrop as
> `C:/home/pi/…` and fails its "must sit under `media_dir`" check (backdrop-spec §5), so no album
> plays. Give it Backdrop's real POSIX path; Curator will not rewrite it.

| Method | Path                        | Purpose                                                                                                |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/backdrop/status`      | `{ enabled }` — whether a Backdrop is configured.                                                      |
| POST   | `/api/backdrop/sync`        | Full library reconcile: push every videoed album (transferring files first). `409` if not configured.  |
| POST   | `/api/backdrop/verify-sync` | Compare Curator's expected projection against Backdrop's live library; return `{ ok, discrepancies }`. |

Backdrop URL and shared secret live in Curator's config:

```toml
[backdrop]
url = "http://backdrop.local:4740"
shared_secret = "..."
push_on_save = true

# Amp — the room rehearsal's audio leg (ADR 0028). Absent → a rehearsal still drives lights and
# video and reports audio as "not configured" rather than failing. Env: AMP_URL.
[amp]
url = "http://runtime-pi.local:4741"
shared_secret = "..."
```

### Application settings

Curator holds application-level settings. Some affect the runtime services and are pushed to them on
change (e.g. the listening room → Conductor); others are Curator-local and never leave the machine
(e.g. Spotify credentials, which only Curator uses).

| Method  | Path                                | Purpose                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~GET~~ | ~~`/api/settings`~~                 | **Never implemented; documented in error.** There is no bare settings resource — settings are per-provider, and the rows below are the whole surface. Curator does call a bare `GET /api/settings`, but that is [Conductor's](hue-conductor-spec.md) route, through the proxy.                                                                                 |
| ~~PUT~~ | ~~`/api/settings`~~                 | **Never implemented; documented in error.** A single merge-everything write was never built; each provider has its own `PUT` below, which is what lets `restartRequired` be answered honestly per provider. Pushing a listening-room change to Conductor goes through `PUT /api/demo/settings`.                                                                |
| ~~GET~~ | ~~`/api/settings/available-rooms`~~ | **Never implemented; superseded 2026-07-25 (issue #101).** The room list and the listening-room push go through the existing Conductor proxy — `GET /api/demo/rooms` and `PUT /api/demo/room` — which Settings and the Demo Room both use. A second route doing the same proxying would be two things to keep correct.                                         |
| GET     | `/api/settings/service-health`      | `{ services: [{ service, configured, reachable, url?, detail? }] }` for conductor, backdrop and amp. Backs Settings' **Test connections**. `configured:false` and `reachable:false` are deliberately distinct — never set up and currently down are different problems. Each probe is bounded (5s) and independent, so one dead service never fails the check. |
| GET     | `/api/settings/spotify`             | Spotify credential status: `{ configured, clientId }`. The client secret is write-only and never returned.                                                                                                                                                                                                                                                     |
| PUT     | `/api/settings/spotify`             | Body `{ clientId, clientSecret }`. Persists to `settings.json` in the data dir; returns `{ ok, restartRequired: true }` (the Spotify client + Roadie are built at boot). Needed by the packaged desktop app, which has no repo `.env` (ADR 0008).                                                                                                              |
| GET     | `/api/settings/gemini`              | Gemini status + opt-in generation flags: `{ configured, generateCardArt, generateVideo }`. The API key is write-only and never returned ([ADR 0012](../adrs/0012-artifact-generation-is-opt-in.md)).                                                                                                                                                           |
| PUT     | `/api/settings/gemini`              | Body `{ apiKey?, generateCardArt?, generateVideo? }` — any provided field is merged (others preserved), so you can toggle generation without re-entering the key. `400` if empty. Returns `{ ok, restartRequired: true }`.                                                                                                                                     |
| GET     | `/api/settings/discogs`             | Discogs credential status: `{ configured, oauthConfigured, username }` — `oauthConfigured` is what gates "log in with Discogs" (issue #59). The token and consumer secret are write-only and never returned. Documented in the prose above but missing from this table until 2026-07-27 ([issue #106](https://github.com/dylanleatham/Marquee/issues/106)).    |
| PUT     | `/api/settings/discogs`             | Body `{ token?, username?, consumerKey?, consumerSecret? }` — a personal access token, the OAuth consumer pair, or both. `400` on an empty save (no token, no complete consumer pair, no username). Returns `{ ok, restartRequired: true }`; the client and auth are built at boot.                                                                            |

Settings that live here:

- `listeningRoomId` — the Hue room Conductor drives when scan events arrive. **Owned by Conductor, not Curator**: Curator reads and writes it through the `/api/demo/*` proxy (issue #101) rather than storing a copy, so there is no second value to drift. Settings and the Demo Room's first-run picker are two views of the same setting.
- ~~Conductor URL + shared secret (exposed for UI editing convenience)~~ / ~~Backdrop URL + shared secret~~ — **not editable in the UI (2026-07-25, issue #101).** These live in `config.toml`/env; Settings only reports whether each service answers. Amp's URL joined them ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)).
- Spotify credentials (`clientId` + write-only `clientSecret`) — **Curator-local, not pushed anywhere**.
  Stored in `settings.json` in the data dir so the packaged desktop app can be configured without a
  repo `.env` (ADR 0008); applied at boot. Layered under `config.toml`/env, so dev is unchanged.
- Spotify **user session** (issue #23 / [ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md)) — the
  OAuth refresh token from a "Connect Spotify" login, persisted in its **own** `spotify-tokens.json`
  in the data dir (not `settings.json`, to keep that file's single-writer invariant). Also
  Curator-local, never pushed. Connect/Disconnect via the `/api/spotify/auth/*` routes take effect
  immediately (no restart). The `spotify.redirect_uri` (loopback callback) defaults to Curator's
  host+port and is overridable via `config.toml`/env.
- ~~Tag placement guide text~~ — **superseded 2026-07-25 (issue #103).** Replaced by an in-app **Writing NFC tags** help page (`/help/tags`), which teaches both the phone and Flipper paths and carries the placement guidance as advice. A blank text field you had to author yourself taught nobody anything; nothing is stored in settings for this any more.

## 9. Video workflow (mostly unchanged from prior spec)

Two entry points depending on how you like to work:

**A. Drag-and-drop in the UI.** From the album detail's video section, drag a video file. It uploads, gets a thumbnail generated, and is attached to that album.

**B. Staging in `/incoming/`, then attach by filename.** An upload that names no `curatorId` lands in
`/incoming/` and is claimed later by `POST /api/albums/:curatorId/attach-video` (or `attach-card-art`)
with the filename as `fileId`.

> **Corrected 2026-07-25.** This previously described a **watched folder** that "picks up new files,
> generates thumbnails, and shows them in the Incoming screen." None of that exists: there is no file
> watcher (`chokidar` was recommended in §5 and never added), and the Incoming screen was never built
> (§10). What is real is the staging directory and attach-by-filename — reachable over the API, but
> with no UI, so the "I generated a batch of ten and don't remember which is which" case it was
> written for is **not currently solved**. Reviving it means a watcher and a browser, not a doc edit;
> raise an issue if that case bites in practice.

**Video processing on ingest:**

1. Probe with `ffprobe` — get duration, resolution, codec, container.
2. Validate: H.264 in MP4 required (or H.265 in MP4 if targeting Pi 5). Reject with a clear error otherwise.
3. Generate thumbnails — first frame and midpoint, 320px wide, jpg.
4. Move to final location if attaching now, or leave in `/incoming/`.

**Upload ceiling.** A single multipart upload is capped at `storage.max_upload_mb` in
`config.toml` (env `CURATOR_MAX_UPLOAD_MB`), default **2048 MB**. Visualizer videos are the only
large uploads; cover and card art are tiny. An over-ceiling upload is rejected with **413** and a
message naming the limit — it is never truncated or partially written into the store (the streamed
temp file is discarded on rejection). Uploads are **streamed straight to a temp file on disk**
before `ffprobe` sees a path — never buffered in memory — so the ceiling is a disk/policy limit,
not a memory-safety knob, and can be raised as far as disk allows without risking an OOM.

> **Note (2026-07-14, [issue #12](https://github.com/dylanleatham/Marquee/issues/12)):** the
> ceiling was previously a hardcoded 500 MB and this section didn't mention it, so real ~1 GB
> visualizer videos were rejected — and `/api/videos/upload` and `/api/card-art/upload` surfaced
> the rejection as a generic `500` rather than a `413`. Both fixed; the ceiling is now configurable
> and specified here.
>
> **Note (2026-07-16, [issue #16](https://github.com/dylanleatham/Marquee/issues/16),
> [ADR 0006](../adrs/0006-stream-uploads-to-disk.md)):** uploads previously buffered the whole file
> in memory (`part.toBuffer()`) before staging it for `ffprobe`, so a large ceiling was an OOM risk
> — the reason the cap existed at all. The file part now streams to a temp file
> (`pipeline(part.file, createWriteStream(...))`); the ceiling is now a plain disk limit. The 413
> behavior is unchanged — @fastify/multipart still truncates an over-ceiling file mid-stream.

## 10. UI screens

> **2026-07-25 — this section now covers _which screens exist_ only.** How Curator looks and behaves
> — design language, the workbench model, the rail, preview modes, keyboard and desktop affordances —
> is specified in **[curator-ui-ux.md](curator-ui-ux.md)**, which wins wherever the two disagree.
> Three decisions from that document rewrote parts of this section:
> [ADR 0026](../adrs/0026-album-detail-is-a-workbench.md) (workbench, not session),
> [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md) (generation is invoked),
> [ADR 0028](../adrs/0028-preview-bench-and-room-modes.md) (bench vs. room preview).

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

The count of "needs you right now" — the number that answers "should I sit down now?" — is shown in
the **app header**, where it is visible while you work.

> **2026-07-25:** this originally said "the browser tab title." Curator ships as a single-window
> Electron app ([ADR 0008](../adrs/0008-desktop-app-supervises-services.md)) — there is no tab, so
> `document.title` puts the count in the OS title bar, invisible while the window is focused. The
> header is its real home; the taskbar/dock badge may optionally mirror it for when the window is not
> focused. See [curator-ui-ux.md](curator-ui-ux.md) §8.

### Add album

Simple, focused screen. Three modes as tabs:

_Spotify search_ — text box with debounced autocomplete against Spotify. Grid of results with cover art. Click to preview metadata + click again to add. Handles most cases.

_Paste URI_ — textarea accepting one URI per line. **Add all** submits the whole list to `/api/albums/batch` in one request and renders the per-item report: a summary line ("1 added · 1 already added · 1 not a URI") plus a row per line that _didn't_ simply succeed, numbered as the user sees them. A clean sweep goes straight to the queue; anything else stays put, because with twenty lines in flight the report **is** the result and navigating away would discard it. For the "I have a list ready" case.

> **Narrowed 2026-07-25 (issue #104).** The endpoint was specified as taking `{ mode, spotifyUri? |
searchQuery? | manualMetadata? }`. Only the Spotify-URI form is batched: a search needs a human to
> disambiguate its results, and manual entry needs an artwork upload, so neither has a meaningful list
> form. Those two stay one-at-a-time on their own tabs.

_Manual entry_ — form with title, artist, year, optional genres, and required art upload. Creates an album with `metadata.source = "manual"`. No Spotify data.

### Album detail (a workbench — [ADR 0026](../adrs/0026-album-detail-is-a-workbench.md))

> **Rewritten 2026-07-25.** This section previously specified a session shape — _"Completed sections
> collapse to one-line summary. Current section expanded"_ — with sections revealed in workflow
> order. That premise was wrong: artifacts routinely arrive out of order (a visualizer already
> rendered, card art already commissioned), and a state-ordered UI makes handing one over impossible
> without first performing steps you don't need. See ADR 0026; the layout rationale is in
> [curator-ui-ux.md](curator-ui-ux.md) §4–5.

_Left, fixed_ — art (large), metadata, state badge, album actions (Demo Room, delete), curatorId.

_Below it, the **rail**_ — five workstations. The selected one gets the full canvas; each is
independently routable (`/albums/:curatorId/video`) and **always reachable**:

| #   | Workstation | Contains                                                                                                                                                                                     |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Look**    | Palette (swatches, editor, role dropdowns, reorder, "reset to auto") · pattern · **where the colours come from** ([ADR 0030](../adrs/0030-palette-from-album-feeling.md)) · artwork override |
| 2   | **Video**   | The five video prompts · clip gallery · splice · drop zone / attached preview · Detach · Replace                                                                                             |
| 3   | **Card**    | The five card-art prompts · candidate set · drop zone / attached preview · Detach · Replace · "Download print version"                                                                       |
| 4   | **Preview** | Bench preview and room rehearsal ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md))                                                                                                  |
| 5   | **Ship**    | Tag URI + QR per object · `.nfc` download · link to the tag-writing help (issue #103) · Mark as written (separate sleeve/card toggles) · Verify physical                                     |

- **Video prompts** — five, default `narrative` style ([ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md)),
  each shown in full with its own **Copy** and, when API generation is on, its own **Generate clip**
  button (one Omni clip from that prompt, into the clip gallery + splice), plus **Regenerate with
  AI** — the only re-draft control ([issue #140](https://github.com/dylanleatham/Marquee/issues/140)
  removed the template style selector). Copying any prompt records the copy itself (moving the album to `awaiting_video` at
  review); there is no separate "mark as copied" button ([ADR 0005](../adrs/0005-video-attach-does-not-require-copying-the-prompt.md)).
- **Card-art prompts** — the five fixed angles ([ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md)),
  each with its own **Copy** (to take to Google Flow / Midjourney) and, when API generation is
  enabled, its own **Generate art** button (one Nano Banana image), plus **Regenerate with AI** —
  the only re-draft control ([issue #140](https://github.com/dylanleatham/Marquee/issues/140)
  removed the template style selector; templates are the fallback only).
- **Prompts are drafted on request, not on arrival** ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)).
  An undrafted section shows a **Draft prompts** button; a section whose artifact is already attached
  leads with the artifact and never auto-drafts.
- **Where the colours come from** (Look, below the palette — [ADR 0030](../adrs/0030-palette-from-album-feeling.md),
  issue #105). **The cover is the default and stays the default**; this is the escape hatch for a
  record whose sleeve doesn't look like it sounds. One button reads colours from how the album
  _sounds_ — two grounded Gemini calls, invoked only, priced in the label — and then offers three
  options side by side with the one in force marked in words:

  | Option               | Colours                                                             |
  | -------------------- | ------------------------------------------------------------------- |
  | **From the cover**   | Today's Palette Press extraction. Free, deterministic, the default. |
  | **From the feeling** | Drawn from how the record sounds, ignoring the sleeve.              |
  | **Blend**            | The cover's dominant kept, the feeling's colours around it.         |

  Asking changes nothing — candidates are stored on the asset and survive a reload, so you can weigh
  them against the sleeve. Choosing a non-cover option sets `palette.source` **and** `handEdited`, so
  the library sweep (§Palettes) leaves it alone; going back to the cover re-extracts and is the only
  destructive move, so it confirms first. Motion follows the palette in force ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)) — otherwise
  the colours would change and the record would still behave like its sleeve.

**Nothing is gated by `roadie.state`.** Drop zones, palette edits and prompt copies are live whenever
their inputs exist — including while Roadie is still processing the album. Actions with real API
preconditions (e.g. `verify-physical` outside `awaiting_verify`) render **disabled with the reason
shown**, never hidden. State drives which workstation is selected by default, and the readiness
indicator on each rail item (_empty · ready · attached · blocked_, always a dot **plus** a word) —
nothing more. Auto-save on edit.

### Preview

The confidence checkpoint, in **two modes** ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)).
The split exists because the listening room may have other people in it — taking over their lights
and audio is a side effect on humans, not a rendering choice.

**Bench preview (default, touches no hardware):**

- The **sleeve** — album art at size, as it sits on the stand
- The **video** loop, at moderate size, with Backdrop-accurate crossfade timing
- The **palette** animating as CSS, driven by the same pattern the runtime will use
- **Audio** — a track from the album, played at the workstation via a Connect transfer to the desktop
  Spotify client, local `Computer` devices only
  ([ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md), built 2026-07-27, issue #93).
  Needs Premium and the desktop client running; without either, the control says so and the bench
  stays silent and usable
- Big **Looks good** button (transitions to next state) · **Something's off** (jump back to Look or
  Video without leaving)

Always available. Catches most "this doesn't feel like the album" issues before you touch a sleeve,
and is the mode for preparing albums while away from the room, or while the room is occupied.

**Room rehearsal (armed):** the real runtime path minus the physical tag — lights → Conductor,
video → Backdrop, audio → Amp, via `simulate-scan`. Requires the room-arm switch (below). This is
what you run before you go writing stickers.

### Room-arm switch

A control in the persistent bottom status bar, beside the Roadie strip. Persisted across launches,
**defaulting to bench**. While set to _bench only_, every hardware-touching control in the app is
disabled with the reason shown — room rehearsal, Demo Room, verify-physical. While _room live_, the
bar says so continuously. One deliberate act at the start of a session, rather than a decision
re-made at every button.

### Demo Room (runtime preview)

> **Added 2026-07-17 ([ADR 0007](../adrs/0007-demo-room-drives-conductor-via-curator-proxy.md)).**
> An expansion of the Preview idea into a full runtime rehearsal, so you can experience "the room
> becomes the record" from the workstation before the Backdrop/Stylus Pis exist.
>
> **2026-07-25 ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)):** the Demo Room is now the
> **full-viewport presentation of Preview's room mode**, not a separate feature — same fan-out, same
> proxy pattern, plus Amp for audio. Everything below stands; two things change. It is **gated on the
> room-arm switch** (it currently sits one click from the album detail and will change the lights in
> an occupied room with no warning), and audio joins lights and video via
> `POST /api/demo/audio` → Amp's `POST /api/admin/play`.

A full-viewport screen (`/demo/:curatorId`, opened from the album detail's **Demo Room** button) that
plays the visualizer fullscreen with Backdrop-accurate transitions (dim idle overlay → play, a
two-layer crossfade on swap) while driving the **real Hue lights** through Conductor:

- **Place sleeve / Lift sleeve** call `POST /api/demo/play` / `/api/demo/stop`. `play` builds the
  album's palette+pattern payload and hands it to Conductor's `POST /api/playback` (which snapshots
  the room and animates the pattern); `stop` restores the pre-demo lighting.
- **Swap** (prev/next over albums with a video) crossfades the video and calls `play` again, so
  Conductor crossfades the lights to the new palette — the "run several records back-to-back for a
  visitor" moment.
- **First-run room picker** if no listening room is set (`GET /api/demo/rooms` → `PUT /api/demo/room`),
  plus a lights-status badge. Conductor being unreachable is shown, not fatal — the local video still
  plays (lights degrade to no-op).

Curator proxies Conductor under `/api/demo/*` so the shared secret stays server-side and there's no
browser CORS (ADR 0007). This is also the reference implementation for Backdrop's eventual SPA.

### ~~Incoming~~ — removed 2026-07-25

> This screen ("list of files in `/incoming/` with thumbnails, filenames, durations; search-then-attach;
> delete for junk") was specced and **never built**, and the `GET /api/incoming` route that backed it
> had no caller. Both are removed rather than finished — the drag-and-drop path on the Video and Card
> workstations covers how videos and card art actually arrive.
>
> The `/incoming/` **directory** stays: an upload that names no album still lands there, and
> `attach-video` / `attach-card-art` still claim from it by filename (§9). That is an API-level path
> with no UI, which is a deliberate narrowing, not an oversight.

### Batch progress

Slide-over panel when a batch operation runs. Progress + cancel.

_(Built 2026-07-25, [issue #104](https://github.com/dylanleatham/Marquee/issues/104).)_ Bottom-right,
above the Roadie strip, and **mounted app-wide rather than inside the screen that started it** — you
launch a sweep from Settings and then go and look at an album while it runs, and a panel scoped to
Settings would lose the run on the first navigation.

It shows the album count as a bar, a **Stop** button while work is in flight, and the per-album
outcome list once the run ends. Each row names its outcome in words — _Regenerated_, _Skipped —
hand-edited_, _Skipped — still processing_, _Skipped — no cover art_, _Failed_ — since colour alone
can't distinguish "deliberately left alone" from "went wrong" ([curator-ui-ux §3.4](curator-ui-ux.md)).
The panel can only be dismissed once the run is over; while it's running, closing it would hide the
only way to stop it.

Progress arrives by **polling `GET /api/jobs/:id`**, not an event stream, and a reload reattaches via
`GET /api/jobs?kind=paletteBatch` — see [ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md).
Cancelling stops the remaining work; palettes already regenerated stay regenerated, and the panel says
so rather than leaving you to guess.

A poll that fails **backs off** (1s, 2s, 4s, 8s, capped at 15s) and, after a few consecutive failures,
the panel says contact is lost while continuing to retry. It never gives up: the sweep is still running
on the server, and what was lost is the view of it. A frozen bar with no explanation is
indistinguishable from a sweep that stopped making progress — §10's degraded state, applied here.

### Settings

Simple form-based screen accessible from a header link or a corner menu. Sections:

- **Listening room** — dropdown of Hue rooms (fetched via `GET /api/demo/rooms`, which proxies
  Conductor). Changing the selection pushes to Conductor via `PUT /api/demo/room`. First in the
  screen, because it is the setting most likely to change. _(Built 2026-07-25, issue #101 — it was
  previously reachable **only** from the Demo Room's first-run picker, so once set there was no way
  to change it short of editing Conductor's settings by hand.)_

  The push is optimistic but **rolled back on failure**: a rejected push restores the previous
  selection and shows the error, rather than leaving the dropdown displaying a room that never
  saved. Conductor being unreachable is reported in place, not an empty dropdown.

- **Services** — reachability of Conductor, Backdrop and **Amp**, via one **Test connections** button
  (`GET /api/settings/service-health`). Each is probed on its own health path — Conductor's
  `/api/bridge/status` (which also reports Hue pairing, the thing that actually stops lights
  working), Backdrop's `/healthz`, Amp's `/api/status`.

  > **Narrowed 2026-07-25 (issue #101).** This originally promised the URLs and shared secrets were
  > **editable in the UI**, writing back to `config.toml`. They are not, deliberately: they change
  > rarely, and a web form is the wrong home for a shared secret. They stay in `config.toml`/env.
  > The genuinely useful half — _is the thing I configured actually answering?_ — is what shipped.

- **Library** — collection-wide maintenance. Today that is one action: **Regenerate all palettes**,
  the "Palette Press changed how colours or motion are chosen, re-derive everything" path. It reports
  through the Batch progress panel above, not in place. A checkbox includes hand-edited palettes;
  ticking it and pressing the button asks for confirmation first, because it is the only control in
  Curator that discards hand-edits, and it does so across the whole collection (§12 — never overwrite
  a hand-edit without explicit user action). _(Built 2026-07-25, issue #104.)_

- ~~**Tag placement guide**~~ — **superseded 2026-07-25 (issue #103).** Instead of a settings field
  holding a reminder you write yourself, Curator ships a **Writing NFC tags** help page at
  `/help/tags`, linked from the Ship workstation (where the question arises) and from the app menu's
  Help submenu. It covers both writing paths end to end and leads with the two mistakes that don't
  announce themselves: writing a sleeve URI onto a card (or vice versa — [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md);
  the tag writes fine and quietly does the wrong thing) and setting NTAG213's one-way lock/password
  pages. Placement guidance lives there as advice. Deeper firmware detail stays in
  [the runbook §A7](../runbook.md) rather than being duplicated in-app.

- **Spotify** — Client ID + write-only Client Secret (needed for search/add), plus a **"Connect Spotify" / "Disconnect"** control (issue #23 / [ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md)). Connect opens the Spotify authorize page in the system browser (Authorization Code + PKCE); once the loopback callback returns, the screen reflects the logged-in state. Login is optional — it routes calls through the user session (personalized search now, Connect playback later); without it Curator uses app-only catalog access. The connect button is disabled until credentials are saved.
- **Gemini** — write-only API key + the opt-in artifact-generation toggles ([ADR 0012](../adrs/0012-artifact-generation-is-opt-in.md)).

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
9. **Album detail — the workbench.** The five-workstation rail ([ADR 0026](../adrs/0026-album-detail-is-a-workbench.md)). Success: click into an album from the queue, land on the workstation matching its state, and be able to reach every other one — including handing over a video for an album Roadie is still processing.
10. **Bench preview.** Sleeve + palette + video combined, plus desk audio ([ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md)); no hardware touched. Success: attach a video to a Roadie-completed album, see the preview render correctly with the room untouched — then start desk audio and confirm the sound comes out of the workstation, not the listening room, and stops when you leave the bench.
11. **Video upload + attachment.** Drag-and-drop + validation + thumbnails. Success: attach a video, see it in the detail view.
12. **Tag payload UI + write flow.** URI, QR, mark-written. Success: write your first NFC sticker end-to-end.
13. **Room rehearsal.** `simulate-scan` fires to Conductor, Backdrop and Amp, behind the room-arm switch. Success: arm the room, run the rehearsal, and the lights, display and Sonos all come up in the other room — then set it back to bench and confirm the same button is disabled with a reason.
14. **Backdrop sync (library + rsync trigger).** Automatic on save + manual buttons. Success: an album completed in Curator plays through the runtime.
15. **Override art support.** ✅ _Built 2026-07-25 (issue #100)._ Upload replaces the fetched art everywhere it is read — palette, card art, video generation — and the palette re-derives. A hand-edited palette is kept unless the user says otherwise (§12). Success: replace an ugly Spotify cover with a better scan, palette updates.
16. **Roadie retry + failure classes.** Graceful degradation, retry UI. Success: add a bogus URI, land at `needs_manual` with clear reason and retry button.
17. **Batch add + batch regenerate.** Paste 20 URIs at once; regenerate all palettes after a Palette Press upgrade. Success: 20 albums queued in one action, with a per-line report for the ones that weren't; all palettes regenerate cleanly in a cancellable background sweep that leaves hand-edits alone. _(Done 2026-07-25 — issue #104, [ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md).)_
18. **Backup on write + status derivation polish.** `.bak` files, issue list, next-step surfacing. Success: fat-finger a palette edit, restore from `.bak`.

## 12. Known gotchas

- **curatorId collisions.** `nanoid` at 8 chars from base32 gives ~1 in a million per pair for reasonable collection sizes — effectively zero. But the code should still handle the collision case (generate a new one and try again) rather than assume uniqueness. This is a 3-line addition; do it in the constructor.
- **Album re-add.** User adds the same Spotify URI twice. Detect on add via `metadata.spotifyUri` lookup — reject with 409 and surface the existing curatorId. Prevents accidental duplicates.
- **Spotify search rate limits.** Autocomplete makes many requests. Debounce heavily (300ms) and cache recent queries. Client-side is enough; no need for server-side caching yet.
- **Art override triggers palette regen.** If a user has hand-edited the palette and then overrides art, options are (a) auto-regen and lose the hand edit, (b) leave the hand edit alone despite new art, (c) ask. The app asks ("You have a hand-edited palette. Regenerate with new art?"). Costs one dialog; prevents surprising data loss.
- **Filesystem paths on Windows.** Store paths as POSIX in JSON; convert at read time. Same guidance as previous spec.
- **Videos in git.** Don't put `/media/` in git. `/album-assets/` yes.
- **The `handEdited` semantics.** Hand-edited palette + Palette Press version bump. If you want to retry the algorithm on this album, "reset to auto" is explicit. Never overwrite a hand-edit without user action.
- **Roadie state races.** If a human edits a palette while Roadie is processing that album, Roadie should hold a per-album lock. Single-threaded Roadie makes this easy: only one album has an active lock at a time. _(2026-07-24: palette editing/re-extract are rejected with 409 while an album is in a processing state — the human retries once it reaches `awaiting_review`; see [ADR 0025](../adrs/0025-palette-edit-rejected-during-processing.md). **2026-07-25:** with `drafting_prompts` out of the pipeline ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)) no processing state holds a palette, so this 409 window closes — the guard stays as defence in depth.)_
- **The `tag.payload` value drift.** If a user renames a curatorId (they shouldn't, but if the code ever grows a rename feature), the physical NFC sticker still says the old ID. Prevent renames. If ever needed, "rename" is really "delete + re-add with new ID" and the sticker must be rewritten physically.
- **Manual entries and Backdrop's library.** Manual albums have no Spotify art URL. Backdrop's library entry uses the local artwork path, which Backdrop needs synced to its SD card. Include `media/artwork/` in the rsync targets, not just `visualizers/`.
