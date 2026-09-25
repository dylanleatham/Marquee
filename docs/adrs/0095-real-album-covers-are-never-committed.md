# ADR 0095 — Real album covers are never committed

**Date:** 2026-09-22
**Status:** Accepted
**Supersedes:** nothing. Amends [testing-strategy §3.4](../specs/testing-strategy.md) (the fixture
album set) and `fixtures/README.md`.

## Context

Testing-strategy §3.4 builds the palette tests on a set of real album covers — Purple Rain, Kind of
Blue, The White Album, the Black Album, Rumours, Unknown Pleasures — because each one is a known-hard
input for Palette Press, and it says every test uses fixtures from that set "rather than random or
invented ones". `fixtures/README.md` and `docs/SETUP.md` said the covers were supplied locally
("you provide these"), but the six JPGs were committed in the initial scaffold and every golden and
integration test ran against them from then on.

The repository is being made public. Those covers are copyrighted artwork owned by the labels, and
the Spotify and Discogs developer terms both restrict redistributing the cover art their APIs serve.
Shipping them in a public repo is redistribution, test fixture or not.

What the tests actually depend on is not the artwork but its **colour character**: one obvious
dominant hue, a second hue family, near-white, true black, muted-and-complex, and black-and-white
linework. That property can be drawn from scratch.

## Decision

1. **Real covers are never committed.** `fixtures/artwork/` is gitignored (bar a `.gitkeep`). Real
   covers dropped there locally still run through the golden tests, and their committed goldens in
   `fixtures/palettes/` stay, since a palette is our own output, not the artwork.
2. **Committed stand-ins replace them in CI.** `fixtures/synthetic-covers/` holds six generated
   covers, one per colour character in §3.4, produced deterministically by
   `packages/palette-press/scripts/gen-synthetic-covers.mjs` (seeded PRNG, fixed JPEG quality — a
   re-run is byte-identical). The golden test reads both directories; tests that need one specific
   cover (the audioFeatures passthrough, Curator's real-Palette-Press integration tests) use
   `vivid-purple.jpg`.
3. The stand-ins are deliberately generic shapes. They must reproduce a cover's colour statistics,
   not its composition — a pastiche of a famous sleeve would bring back the problem this solves.

## Consequences

- CI no longer tests real artwork, only synthetic art with the same colour character. Four of the
  six also land on the real cover's outcome (purple-led and rotating; the three
  `insufficient: monochrome`). Two do not, and are kept for their colour rather than their pattern:
  `vivid-blue` rotates where Kind of Blue crossfades, and `muted-complex` crossfades where Rumours
  rotates. A regression that only real-world texture triggers is caught locally, not in CI.
- The real covers' goldens are no longer checked in CI. They still fail loudly locally if they go
  stale, and the golden test now fails — rather than writing one — when a cover has no golden. §3.4's rule —
  "add a fixture the first time a real album causes a regression" — becomes: add its colour
  character as a synthetic cover, and keep the real cover local.
- The removed JPGs remain in git history. A force-push cannot remove them from GitHub's read-only
  `refs/pull/*` refs, and rewriting history would break every PR and issue link. The exposure is six
  small test thumbnails; this ADR stops the redistribution going forward.
- `generate.test.ts`'s passthrough tests no longer skip when art is absent: the stand-in is always
  there, so they always run.
