# Curator

Admin app + source of truth for the collection; hosts Roadie. Runs on your workstation
(Fastify API; the React UI comes in a later step). Specs:
[curator](../../docs/specs/curator-spec.md) ·
[roadie](../../docs/specs/roadie-spec.md) ·
[onboarding workflow](../../docs/specs/album-onboarding-workflow.md).

## Status — build step 3 (asset store + manual add + Palette Press)

Implemented: the album-assets store (`{curatorId}.json`, `.bak` on overwrite), curatorId
generation, and **manual add-album** — which saves the cover, runs Palette Press, and writes
the asset (state `awaiting_review`). Spotify add (step 4), Roadie's background worker (step 5),
video/preview/tag flows, and the UI come later.

## Run

```bash
pnpm --filter @marquee/curator dev     # tsx watch, http://127.0.0.1:4739
```

Data lives under `~/marquee/` by default (`album-assets/` + `media/`); override with
`MARQUEE_DATA_DIR` or `config.toml`. Curator's own API is unauthenticated (LAN-only, like
Home Assistant — runtime-overview §8).

## Endpoints (step 3)

| Method | Path                     | Purpose                                                                                                                             |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`               | `{ ok, albums }`                                                                                                                    |
| POST   | `/api/albums`            | Manual add. `multipart/form-data`: fields `name`, `artist`, `year?`, `genres?` (comma-sep) + an `artwork` file. Runs Palette Press. |
| GET    | `/api/albums`            | List album summaries (newest first).                                                                                                |
| GET    | `/api/albums/:curatorId` | Full asset JSON.                                                                                                                    |
| DELETE | `/api/albums/:curatorId` | Remove the asset (media untouched).                                                                                                 |

## Smoke test (the step-3 payoff)

```bash
curl -s -X POST http://127.0.0.1:4739/api/albums \
  -F name="Purple Rain" -F artist="Prince" -F year=1984 \
  -F artwork=@fixtures/artwork/purple-rain.jpg
# → { "curatorId": "…", "state": "awaiting_review", "paletteColors": 4, "paletteInsufficient": false }
curl -s http://127.0.0.1:4739/api/albums/<curatorId>   # palette saved on disk
```

## Notes

- The `AlbumAsset` shape lives in `src/albums/asset.ts` (step-3 subset of curator-spec §7). It
  should move to `@marquee/contracts` (`album-asset.schema.json`) and gain validate-on-save once
  the shape settles.
- Palette generation is synchronous here; Roadie (step 5) moves it to a background worker and
  adds the metadata/art/prompt steps.
