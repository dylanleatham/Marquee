# Curator

Admin app + source of truth for the collection; hosts Roadie. Runs on your workstation
(Fastify API + a Vite/React UI in [`ui/`](ui), served by Fastify from `dist-ui/` in production).
Specs: [curator](../../docs/specs/curator-spec.md) ·
[roadie](../../docs/specs/roadie-spec.md) ·
[onboarding workflow](../../docs/specs/album-onboarding-workflow.md).

## Status — build step 7 (video upload + attachment + preview)

The onboarding workflow now runs through the human steps. From the album detail you can copy the
video prompt (which moves the album to `awaiting_video`), attach a video (upload or claim one from
`/incoming/`), preview it against the animating palette, and approve — walking
`awaiting_review → awaiting_video → awaiting_preview → awaiting_tag_write`. Card art can be attached
at any point (independent of the state machine), with a print-download.

Video ingest validates the upload is **H.264/H.265 in MP4** via `ffprobe` and renders a thumbnail
via `ffmpeg` (both required on `PATH`, or set `FFPROBE_PATH`/`FFMPEG_PATH`). The prober is injected,
so the test suite never shells out to ffmpeg.

### The UI (step 6)

Primary screens (Vite + React + TypeScript under `ui/`, built to `dist-ui/`, served by Fastify at
`/`): **Queue view** (grouped, live-polled, tab badge), **Album detail** (stepper, palette, prompts,
and — as of step 7 — the video / card-art / preview sections), **Add album** (Spotify search /
paste-URI / manual), and a persistent **Roadie strip** with pause/resume.

## Roadie (step 5)

The album-assets store (`{curatorId}.json`, `.bak` on overwrite), curatorId generation, and
add-album (manual cover upload / Spotify by URI + search, deduped on the URI) back the UI above.

**Roadie** owns the pre-handoff work: adding an album no longer does it on the
request path — `POST /api/albums` writes a `fresh` asset, enqueues it, and returns immediately.
The in-process worker then drives each album forward through its sub-states
(`fetching_metadata → downloading_art → generating_palette → drafting_prompts`) to
`awaiting_review`, one album at a time, with:

- **Retry + backoff** (1s/4s/15s/60s + jitter) on transient failures, then `errored`.
- **Failure classes**: 404 → `needs_manual` (`album_not_on_spotify` / `art_unavailable`); auth →
  `errored`; monochrome art → `awaiting_review` with a `palette_insufficient` flag (not an error).
- **Prompt drafting**: video + card-art prompts from metadata + palette (roadie-spec §7).
- **Crash resilience**: `recover()` re-enqueues albums left mid-processing at startup; each
  sub-step is idempotent, so it resumes from where it left off.
- **Controls + observability**: pause/resume, manual retry, a queue grouped by human-facing
  state, and a status/activity feed.

Not yet built (later steps): tag-write / physical-verify flows and palette editing, and Roadie's
**Backdrop sync triggers** (★ in roadie-spec §6) — deferred until Backdrop exists (step 8), since
there's no downstream to sync to yet. `card-art/print` serves the stored image verbatim for now;
embedding 300-DPI metadata waits on an image pipeline.

Spotify is optional: set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (env or `config.toml
[spotify]`). Without them, `/api/spotify/*` and JSON add return 503; manual add still works.

## Run

One command from the repo root — builds the API + UI, starts the server, and opens the browser:

```bash
pnpm curator          # → builds, serves API+UI at http://127.0.0.1:4739, opens it
```

The server auto-loads the repo-root `.env`, so `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`
there enable Spotify search + add-by-URI with no extra flags. Without them, manual add (cover
upload) still works. On startup it prints the URL and warns if Spotify or ffmpeg is missing.

**Developing** (hot reload) — two terminals:

```bash
pnpm --filter @marquee/curator dev     # API: tsx watch, http://127.0.0.1:4739 (also loads .env)
pnpm --filter @marquee/curator dev:ui  # UI: Vite on :4738, proxies /api → :4739  → open :4738
```

Video attach needs **ffmpeg** (`ffprobe` + `ffmpeg`) on `PATH`, or point at them with
`FFPROBE_PATH` / `FFMPEG_PATH`. Everything else works without it.

Data lives under `~/marquee/` by default (`album-assets/` + `media/`); override with
`MARQUEE_DATA_DIR` or `config.toml`. Curator's own API is unauthenticated (LAN-only, like
Home Assistant — runtime-overview §8).

Uploads are capped at **2048 MB** per file — override with `CURATOR_MAX_UPLOAD_MB` (env) or
`storage.max_upload_mb` (`config.toml`). Only visualizer videos get anywhere near it; going over
returns a `413` naming the limit (spec §9).

## Endpoints (through step 7)

| Method | Path                             | Purpose                                                                                                                                                                                                       |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                       | `{ ok, albums, spotify, roadie }`                                                                                                                                                                             |
| POST   | `/api/albums`                    | **Multipart** → manual add (`name`, `artist`, `year?`, `genres?` + `artwork` file). **JSON** → Spotify add (`{ spotifyUri }` or `{ spotifyId }`). Enqueues in Roadie; returns `{ curatorId, source, state }`. |
| GET    | `/api/albums`                    | List album summaries (newest first).                                                                                                                                                                          |
| GET    | `/api/albums/:curatorId/artwork` | Resolved cover art (jpg); 404 until Roadie downloads it. Backs the UI thumbnails.                                                                                                                             |
| GET    | `/api/agent/queue/counts`        | Per-bucket counts + the "needs you right now" total, for the browser-tab badge.                                                                                                                               |
| GET    | `/api/albums/:curatorId`         | Full asset JSON.                                                                                                                                                                                              |
| DELETE | `/api/albums/:curatorId`         | Remove the asset (media untouched).                                                                                                                                                                           |
| GET    | `/api/agent/queue`               | Albums grouped by human-facing state (`awaiting_*`, `processing`, `errored`, `needs_manual`, `done_recently`).                                                                                                |
| GET    | `/api/agent/status`              | Roadie's current item, queue depth, paused flag, recent activity log.                                                                                                                                         |
| POST   | `/api/agent/retry/:curatorId`    | Re-run an album parked in `errored` / `needs_manual` (409 otherwise).                                                                                                                                         |
| POST   | `/api/agent/pause` · `/resume`   | Stop / start picking up new work (in-flight work finishes).                                                                                                                                                   |
| GET    | `/api/spotify/search-albums?q=`  | Autocomplete album search (503 if Spotify unconfigured).                                                                                                                                                      |
| GET    | `/api/spotify/album/:spotifyId`  | Preview one album's Spotify metadata.                                                                                                                                                                         |

### Onboarding actions (step 7)

| Method | Path                                                                     | Purpose                                                                                           |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/albums/:id/prompts/:type/copied`                                   | Mark a prompt copied. Video → advances `awaiting_review → awaiting_video`.                        |
| POST   | `/api/videos/upload`                                                     | Multipart. With `curatorId` → ingest + attach (`→ awaiting_preview`); else stash in `/incoming/`. |
| GET    | `/api/incoming`                                                          | List unclaimed files in `/incoming/`.                                                             |
| POST   | `/api/albums/:id/attach-video`                                           | Claim an `/incoming/` file by `{ fileId }` and attach it.                                         |
| POST   | `/api/albums/:id/detach-video`                                           | Remove the visualizer (`?delete=1` deletes the file); steps back to `awaiting_video`.             |
| POST   | `/api/card-art/upload` · `attach-card-art` · `detach-card-art`           | Same shape as video, for the Curator-only card art (state-independent).                           |
| POST   | `/api/albums/:id/preview/approve`                                        | "Looks good" → `awaiting_tag_write`.                                                              |
| POST   | `/api/albums/:id/preview/reject`                                         | "Something's off" → `{ to: awaiting_review \| awaiting_video }`.                                  |
| GET    | `/api/albums/:id/video` · `/thumbnail` · `/card-art` · `/card-art/print` | Stream the attached media.                                                                        |

## Smoke test (the step-5 payoff: add, walk away, come back to `awaiting_review`)

```bash
# Spotify (needs SPOTIFY_CLIENT_ID/SECRET) — returns immediately, state "fetching_metadata"
curl -s -X POST http://127.0.0.1:4739/api/albums \
  -H content-type:application/json -d '{"spotifyUri":"spotify:album:1C2h7mLntPSeVYciMRTF4a"}'
# → { curatorId, source: "spotify", state: "fetching_metadata" }

# A moment later, Roadie has driven it through the pipeline:
curl -s http://127.0.0.1:4739/api/agent/queue          # album now under awaiting_review
curl -s http://127.0.0.1:4739/api/albums/<curatorId>   # metadata + art + palette + prompts on disk

# Manual (cover upload) — starts at "generating_palette" (art + metadata already supplied)
curl -s -X POST http://127.0.0.1:4739/api/albums \
  -F name="Purple Rain" -F artist="Prince" -F year=1984 \
  -F artwork=@fixtures/artwork/purple-rain.jpg
```

## Notes

- The `AlbumAsset` shape lives in `src/albums/asset.ts` (curator-spec §7). `palette`/`pattern`/
  `promptDrafts` are optional — they don't exist until Roadie generates them. It should move to
  `@marquee/contracts` (`album-asset.schema.json`) and gain validate-on-save once the shape settles.
- Roadie lives in `src/roadie/` — `worker.ts` (queue + state machine), `steps.ts` (the sub-steps),
  `prompts.ts` (prompt drafting), `backoff.ts` + `errors.ts` (retry policy).
