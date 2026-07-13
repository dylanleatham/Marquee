# Curator

Admin app + source of truth for the collection; hosts Roadie. Runs on your workstation
(Fastify API + a Vite/React UI in [`ui/`](ui), served by Fastify from `dist-ui/` in production).
Specs: [curator](../../docs/specs/curator-spec.md) ·
[roadie](../../docs/specs/roadie-spec.md) ·
[onboarding workflow](../../docs/specs/album-onboarding-workflow.md).

## Status — build step 6 (Curator UI: queue view + album detail)

The primary screens are live (Vite + React + TypeScript under `ui/`, built to `dist-ui/` and
served by Fastify at `/`):

- **Queue view** — albums grouped by human-facing state ("Needs you right now" / "Roadie is on
  it" / "Needs your attention" / "Done"), live-polled so they flow as Roadie processes them, with
  cover thumbnails, search, and the browser-tab "needs you" badge.
- **Album detail** — read-mostly: state stepper, palette swatches, pattern, and the drafted
  video + card-art prompts with Copy buttons; Retry/Delete actions. Palette editing, video/preview,
  and tag/verify flows arrive with their own steps (7+).
- **Add album** — Spotify search (debounced), paste-URI, and manual-entry (cover upload) tabs.
- **Roadie strip** — persistent footer showing what Roadie's doing, with pause/resume.

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

Not yet built (later steps): video/preview/tag flows and palette editing (steps 7+), and Roadie's
**Backdrop sync triggers** (★ in roadie-spec §6) — deferred until Backdrop exists (step 8), since
there's no downstream to sync to and no human-driven transitions to observe yet.

Spotify is optional: set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (env or `config.toml
[spotify]`). Without them, `/api/spotify/*` and JSON add return 503; manual add still works.

## Run

```bash
pnpm --filter @marquee/curator dev     # API: tsx watch, http://127.0.0.1:4739
pnpm --filter @marquee/curator dev:ui  # UI: Vite dev server on :4738, proxies /api → :4739
```

For a production-style run, `pnpm --filter @marquee/curator build` (compiles the API and builds
the UI to `dist-ui/`), then `pnpm --filter @marquee/curator start` — Fastify serves the UI at `/`.

Data lives under `~/marquee/` by default (`album-assets/` + `media/`); override with
`MARQUEE_DATA_DIR` or `config.toml`. Curator's own API is unauthenticated (LAN-only, like
Home Assistant — runtime-overview §8).

## Endpoints (through step 6)

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
