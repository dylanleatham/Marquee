# Marquee

_An immersive jukebox. Place a tagged record sleeve on the stand — the lights and the
display become the record. Lift it — the room returns to normal._

Four services, one library, one background agent, sharing a small set of versioned
contracts. See [`docs/specs/runtime-overview.md`](docs/specs/runtime-overview.md) for the
one-page systems doc, then the individual specs.

## The pieces

| Piece             | What it is                                                               | Runs on              | Package                       |
| ----------------- | ------------------------------------------------------------------------ | -------------------- | ----------------------------- |
| **Curator**       | Admin app + source of truth for the collection. Hosts Roadie.            | Your workstation     | `packages/curator`            |
| **Roadie**        | Background agent inside Curator (metadata, art, palette, prompts, sync). | (inside Curator)     | `packages/curator/src/roadie` |
| **Palette Press** | Pure library: album art → Hue-safe palette.                              | (library)            | `packages/palette-press`      |
| **Hue Conductor** | Drives Hue lights from palette+pattern payloads.                         | Pi 5 near TV         | `packages/hue-conductor`      |
| **Backdrop**      | Plays looping visualizer videos on the display.                          | Pi 5 near TV         | `packages/backdrop`           |
| **Stylus**        | Reads NFC tags, publishes scan events. **Python.**                       | Pi Zero 2 W in stand | `packages/stylus`             |
| **Contracts**     | Shared JSON schemas + generated types for every boundary.                | —                    | `packages/contracts`          |
| **Fakes**         | Hand-written fakes of external deps (Hue bridge, Spotify, PN532).        | —                    | `packages/fakes/*`            |

> **Naming note:** the dev-harness/testing-strategy docs sketch the Python service's
> folder as `nfc-trigger`; the runtime overview commits to the name **Stylus**. This
> scaffold uses `packages/stylus` to match the committed service names. Rename if you
> prefer the doc's folder name — it's a find/replace, do it before writing much code.

## Build order

From `runtime-overview.md §10`, reordered so each step is demoable and compounds. **Steps
1–5 are backend-only and need no new hardware** (just your existing Hue bridge for step 1).

0. **Harness first.** Monorepo skeleton (done), `contracts` package with real schemas
   (done), first `fake-hue-bridge`, GitHub repo + branch protection, contract-test CI.
1. **Conductor + a hand-crafted palette JSON.** `curl` a payload → your real lights change.
   Proves the hardest concrete integration (Hue local API).
2. **Palette Press**, run once on one album via CLI. Prove extraction quality.
3. **Curator, minimal** — asset store + manual add-album + Palette Press. One album add→saved.
4. **Spotify integration in Curator** — add via URI/search, real metadata + art.
5. **Roadie skeleton** — worker loop + state machine (mocked steps → real steps).
6. **Curator UI** — queue view + album detail (the screens you'll live on).
7. **Video upload + attachment + preview.**
8. **Backdrop, minimal** — kiosk Chromium, hardcoded video, HTTP endpoint.
9. **Backdrop library sync from Curator** — add in Curator, see it play.
10. **Stylus, on the bench** — read tags, publish events to stub then real endpoints.
11. **Physical stand integration** — mount, tune, tag your first sleeves. The real moment.
12. **Failure-mode iteration** — idle timeouts, missing-file handling, LED patterns, retries.

## Getting started

```bash
pnpm install          # after installing pnpm + Node 20 (see "What you need" below)
pnpm run setup        # verifies toolchain, installs hooks, seeds .env
pnpm run test:fast    # unit + contract tests
pnpm run dev          # all Node services locally against fakes (as they get built)
```

Full toolchain + hardware + accounts checklist: see `docs/SETUP.md`.

## Repo layout

```
packages/            contracts, fakes, palette-press, curator, hue-conductor, backdrop, stylus
fixtures/            album art, golden palettes, tiny test videos, NDEF byte fixtures
contract-tests/      cross-service boundary tests
e2e/                 end-to-end runtime scenarios
review-agents/       Claude Code review specialists (pre-push gate)
scripts/             setup, schema codegen, smoke tests
docs/specs/          the specs (source of truth for behavior)
docs/adrs/           architecture decision records
```
