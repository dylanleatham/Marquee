# Curator

Admin app + source of truth for the collection; hosts Roadie. Runs on your workstation
(Fastify API; the React UI comes in a later step). Specs:
[curator](../../docs/specs/curator-spec.md) ·
[roadie](../../docs/specs/roadie-spec.md) ·
[onboarding workflow](../../docs/specs/album-onboarding-workflow.md).

## Status — build steps 3–4 (asset store + manual & Spotify add + Palette Press)

Implemented: the album-assets store (`{curatorId}.json`, `.bak` on overwrite), curatorId
generation, **manual add-album** (cover upload), and **Spotify add** (by URI/search — real
metadata + art fetch via the client-credentials flow, deduped on the Spotify URI). Both run
Palette Press and write the asset (state `awaiting_review`). Roadie's background worker (step 5),
video/preview/tag flows, and the UI come later.

Spotify is optional: set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (env or `config.toml
[spotify]`). Without them, `/api/spotify/*` and JSON add return 503; manual add still works.

## Run

```bash
pnpm --filter @marquee/curator dev     # tsx watch, http://127.0.0.1:4739
```

Data lives under `~/marquee/` by default (`album-assets/` + `media/`); override with
`MARQUEE_DATA_DIR` or `config.toml`. Curator's own API is unauthenticated (LAN-only, like
Home Assistant — runtime-overview §8).

## Endpoints (steps 3–4)

| Method | Path                            | Purpose                                                                                                                                                                   |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                      | `{ ok, albums, spotify }`                                                                                                                                                 |
| POST   | `/api/albums`                   | **Multipart** → manual add (`name`, `artist`, `year?`, `genres?` + `artwork` file). **JSON** → Spotify add (`{ spotifyUri }` or `{ spotifyId }`). Both run Palette Press. |
| GET    | `/api/albums`                   | List album summaries (newest first).                                                                                                                                      |
| GET    | `/api/albums/:curatorId`        | Full asset JSON.                                                                                                                                                          |
| DELETE | `/api/albums/:curatorId`        | Remove the asset (media untouched).                                                                                                                                       |
| GET    | `/api/spotify/search-albums?q=` | Autocomplete album search (503 if Spotify unconfigured).                                                                                                                  |
| GET    | `/api/spotify/album/:spotifyId` | Preview one album's Spotify metadata.                                                                                                                                     |

## Smoke test (the steps 3–4 payoff)

```bash
# Manual (cover upload)
curl -s -X POST http://127.0.0.1:4739/api/albums \
  -F name="Purple Rain" -F artist="Prince" -F year=1984 \
  -F artwork=@fixtures/artwork/purple-rain.jpg

# Spotify (needs SPOTIFY_CLIENT_ID/SECRET) — fetches real metadata + art
curl -s -X POST http://127.0.0.1:4739/api/albums \
  -H content-type:application/json -d '{"spotifyUri":"spotify:album:1C2h7mLntPSeVYciMRTF4a"}'
# → { curatorId, source, state: "awaiting_review", paletteColors, paletteInsufficient }
curl -s http://127.0.0.1:4739/api/albums/<curatorId>   # palette + metadata saved on disk
```

## Notes

- The `AlbumAsset` shape lives in `src/albums/asset.ts` (step-3 subset of curator-spec §7). It
  should move to `@marquee/contracts` (`album-asset.schema.json`) and gain validate-on-save once
  the shape settles.
- Palette generation is synchronous here; Roadie (step 5) moves it to a background worker and
  adds the metadata/art/prompt steps.
