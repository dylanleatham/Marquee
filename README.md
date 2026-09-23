# Marquee

_An immersive jukebox. Place a tagged record sleeve on the stand — the lights and the display
become the record. Lift it — the room returns to normal._

<!-- Demo: a short clip of a sleeve going on the stand, the Hue lights shifting and the visualizer
starting, belongs here. -->

An NFC reader hidden in a record stand identifies the sleeve. The room's Philips Hue lights take on
a palette pressed from the album's cover art, a TV plays a looping visualizer made for that record,
and — for a tagged card rather than a sleeve — the album starts on the house Sonos. Lifting the
record puts the room back exactly how it was.

It is a small distributed system: five services across a Windows workstation, a Raspberry Pi 5 and
a Raspberry Pi Zero 2 W, in TypeScript and Python, talking over versioned JSON contracts on the LAN.

## How it works

```mermaid
flowchart LR
    subgraph stand["Record stand · Pi Zero 2 W"]
        Stylus["Stylus<br/>NFC reader · Python"]
    end
    subgraph runtime["By the TV · Pi 5"]
        Conductor["Hue Conductor<br/>lights"]
        Backdrop["Backdrop<br/>visualizer video"]
        Amp["Amp<br/>Sonos audio"]
    end
    subgraph workstation["Workstation · desktop app"]
        Curator["Curator + Roadie<br/>collection, onboarding"]
    end
    Stylus -- "scan / stop events" --> Conductor & Backdrop & Amp
    Curator -- "album assets<br/>(palette, pattern)" --> Conductor & Amp
    Curator -- "videos + library" --> Backdrop
    Conductor --> Hue[("Hue bridge")]
    Amp --> Sonos[("Sonos")]
    Curator -.-> APIs[("Spotify · Discogs · Gemini")]
```

| Piece             | What it does                                                                                  | Runs on               | Package                  |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| **Stylus**        | Reads NFC tags, debounces them, and fans scan events out to the runtime services              | Pi Zero 2 W, in stand | `packages/stylus`        |
| **Hue Conductor** | Drives the Hue lights from a palette + pattern; restores the room afterwards                  | Pi 5                  | `packages/hue-conductor` |
| **Backdrop**      | Plays the record's looping visualizer in a kiosk browser                                      | Pi 5, on the TV       | `packages/backdrop`      |
| **Amp**           | Streams a card-tagged album (or one chosen track) over Sonos via local UPnP                   | Pi 5                  | `packages/amp`           |
| **Curator**       | The admin app and source of truth for the collection; hosts **Roadie**, the onboarding agent  | Workstation           | `packages/curator`       |
| **Palette Press** | Pure library: album art → a Hue-safe palette and a light pattern                              | (library)             | `packages/palette-press` |
| **Desktop**       | Electron shell that supervises Curator + a local Conductor in one window                      | Workstation           | `packages/desktop`       |
| **Deploy**        | Puts one pinned commit on every host and verifies it landed                                   | Workstation → Pis     | `packages/deploy`        |
| **Contracts**     | JSON Schemas + types for every service boundary, shared by TypeScript and Python              | —                     | `packages/contracts`     |
| **Fakes**         | Hand-written fakes of every external dependency (Hue bridge, Spotify, Discogs, Gemini, PN532) | —                     | `packages/fakes/*`       |

The one-page systems doc is [docs/specs/runtime-overview.md](docs/specs/runtime-overview.md) —
start there, then the per-service specs in [docs/specs/](docs/specs/).

## Engineering highlights

- **Hang-safe hardware I/O.** A wedged I²C call blocks inside a C extension where Python can't
  interrupt it, and systemd can't see a hang. [`bounded.py`](packages/stylus/stylus/bounded.py)
  turns the hang into a crash so `Restart=always` can recover it — the reasoning is in the module
  docstring. See also [`watchdog.py`](packages/stylus/stylus/watchdog.py).
- **Property-tested state machines.** Stylus's scan/swap/lift logic is pure and tested with
  Hypothesis ([`state_machine.py`](packages/stylus/stylus/state_machine.py),
  [tests](packages/stylus/tests/test_state_machine.py)).
- **Contracts across the language boundary.** Every inter-service payload has a JSON Schema in
  [`packages/contracts/schemas`](packages/contracts/schemas), validated by the TypeScript services,
  the Python reader, and a cross-service [contract test suite](contract-tests/).
- **Runs without the hardware.** Each external system has a hand-written fake — a Hue CLIP v2
  bridge, Spotify, Discogs, Gemini, the PN532 reader — so the whole stack is testable on a laptop.
- **Colour science for real lights.** [Palette Press](packages/palette-press) extracts swatches,
  clamps them into the Hue gamut in CIE xy, filters by ΔE contrast, detects monochrome art, and
  picks a light pattern from the palette's energy.
- **Deterministic deploys.** `pnpm run deploy` puts one pinned commit on every host, converges the
  systemd units by hash, rolls back on a failed restart, and proves the result
  ([ADR 0080](docs/adrs/0080-deployment-is-one-pinned-commit-verified-on-every-host.md)).
- **Measured, not guessed.** An always-on system has an idle budget:
  [idle-cost-baseline.md](docs/specs/idle-cost-baseline.md) measures every configuration (none costs
  more than 1.2% of one CPU core). CI is cost-engineered the same way
  ([ADR 0064](docs/adrs/0064-ci-is-priced-per-pr-expensive-checks-move-to-nightly.md)).
- **Decisions on the record.** 95 [architecture decision records](docs/adrs/) and specs that are
  kept in step with the code — when the code deviates, the spec is updated and an ADR says why.

## How it was built

Spec-first and test-first. Every service has a spec in [docs/specs/](docs/specs/) that is treated
as the source of truth; every bug fix starts with a failing test that reproduces it, then closes the
gap in the harness that let it through ([bug-fix-workflow.md](docs/specs/bug-fix-workflow.md)).

Implementation was pair-programmed with [Claude Code](https://claude.com/claude-code) — which is
why many commits carry a co-author trailer. The guardrails around that are part of the project:
[CLAUDE.md](CLAUDE.md) is the working agreement, [review-agents/](review-agents/README.md) are
three custom reviewers that check things a generic reviewer can't know about this repo (tests that
silently run nothing, spec drift, missing coverage), and the git hooks and
[`.claude/`](.claude/README.md) skills enforce the procedures rather than relying on reminders.

## Tech stack

TypeScript on Node 22 (Fastify, React + Vite, Electron, Vitest) · Python 3.11 (stdlib core,
Hypothesis) · pnpm workspaces + Turborepo · JSON Schema · GitHub Actions · Raspberry Pi 5 and Pi
Zero 2 W, PN532 NFC over I²C, systemd · Philips Hue CLIP v2, Sonos UPnP, Spotify, Discogs and
Gemini APIs.

## Getting started

Needs Node 22 and pnpm 9 (Python 3.11+ only for Stylus).

```bash
pnpm install         # also installs the git hooks (husky)
pnpm run setup       # verifies the toolchain, seeds .env from .env.example
pnpm run build
pnpm run test:fast   # unit + contract tests — no hardware or API keys needed
```

Building the real thing — accounts, the Hue pairing, the Pis and the stand — is covered in
[docs/SETUP.md](docs/SETUP.md), with a phased bill of materials in
[docs/specs/parts-list.md](docs/specs/parts-list.md) and deployment in
[packages/deploy](packages/deploy).

## Repo layout

```
packages/        the services, libraries, desktop shell, deploy tool, and fakes
contract-tests/  cross-service boundary tests against the shared schemas
fixtures/        synthetic cover art, golden palettes, test data
review-agents/   the three custom code reviewers (`pnpm run review`)
spikes/          throwaway feasibility experiments, each tied to an ADR
flipper/         a Flipper Zero app for writing tags
docs/specs/      the specs — the source of truth for behaviour
docs/adrs/       architecture decision records
```

## License

[MIT](LICENSE). Marquee is a personal project and is not affiliated with or endorsed by Signify
(Philips Hue), Sonos, Spotify, Discogs or Google; their names are used only to describe what
Marquee works with.
