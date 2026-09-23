# Fixtures

Chosen to cover the space of real inputs (testing-strategy §3.4). Never remove one; add one
the first time a real album causes a regression.

- `artwork/` — real album covers (JPG), **local only and gitignored**: they are copyrighted
  ([ADR 0095](../docs/adrs/0095-real-album-covers-are-never-committed.md)). Drop them in to run the
  golden tests against real art.
- `synthetic-covers/` — committed, generated stand-ins, one per colour character in the table
  below. Regenerate with `node packages/palette-press/scripts/gen-synthetic-covers.mjs`.
- `palettes/` — golden palette outputs + reference payloads (e.g. `purple-rain.payload.json`).
- `videos/` — tiny test videos (320×240, ~2s, H.264/MP4) for Backdrop tests. Not real visualizers.
- `ndef/` — NDEF byte fixtures for Stylus NDEF-parsing tests.

## The fixture album set (per testing-strategy §3.4)

| Album                            | Why                                               |
| -------------------------------- | ------------------------------------------------- |
| Purple Rain — Prince             | Obvious dominant color; canonical validation      |
| Kind of Blue — Miles Davis       | Obvious color, different genre                    |
| The White Album — Beatles        | Nearly monochrome — challenges the post-processor |
| Metallica (Black Album)          | Truly monochrome — expect `insufficient`          |
| Rumours — Fleetwood Mac          | Muted, complex — realistic middle case            |
| Unknown Pleasures — Joy Division | B&W, iconic — hardest realistic case              |
| A recent color-rich album        | Current-era art                                   |
| A recent grayscale/minimal album | Current-era minimalism                            |
