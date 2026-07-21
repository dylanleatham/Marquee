# ADR 0016 — Stylus core is stdlib-only; hardware lives behind injectable seams

Status: accepted · Date: 2026-07-21 · Amends: stylus-spec §6 (software stack), §8–§9 ("Player" →
"Backdrop"), §11 (milestones)

## Context

Build step 10 is "Stylus, on the bench": prove the whole software chain — read → debounce → publish —
without the physical PN532. Two forces shaped how:

1. **CI has no hardware and no third-party libs.** The `python (stylus)` job installs only dev tools
   (`pytest ruff mypy jsonschema freezegun hypothesis responses`) and runs `pytest -q`. It does
   **not** install the package's own runtime deps — `adafruit-circuitpython-pn532` doesn't install
   off-Pi at all, and `httpx`/`ndeflib` simply aren't there. So any module imported during test
   collection must not require them.
2. **The spec suggests libraries, not mandates.** §6 says "httpx (async) _or_ requests (sync). Sync
   is fine" and suggests `ndeflib`; §5 sets the tone — "the trigger service stays under 300 lines".

## Decision

**Keep the Stylus core stdlib-only, and put every hardware/third-party touchpoint behind an
injectable seam.**

- **HTTP: stdlib `urllib`**, not httpx/requests. The publisher takes an injectable `transport`
  (default `urllib_transport`) and `sleep`, so the §8 retry window is unit-tested with a fake — no
  sockets, no waiting, no HTTP dependency in the tested path.
- **NDEF: a ~40-line hand-rolled parser**, not `ndeflib`. The tag only ever carries one
  `curator:album:<id>` URI (everything else is out of scope, §3), so we parse exactly the
  well-known URI (and Text) record we need. Pure and fully tested off-hardware.
- **Reader seam:** a `TagReader` protocol with `SimulatedReader` (bench/tests, driven by
  `POST /simulate`) and `create_pn532_reader` (Pi; imports `adafruit_pn532` **lazily**, so the module
  imports fine off-Pi). The NDEF _page assembly_ is factored out as a pure, tested helper; only the
  live I2C loop is Pi-only.
- **LED seam:** the app speaks semantic patterns (`idle`/`playing`/`error`/`start_ack`); the bench
  logs them, the real GPIO/PWM driver is wired on the Pi.

**"Player" is renamed to "Backdrop"** throughout config and the spec (Backdrop is the committed name,
runtime-overview §12). `[downstream.player]` is still accepted as a **legacy alias** so an old config
doesn't break.

**Milestone split.** Bench milestones (§11 #3 state machine, #4 HTTP-vs-stub, #8 LED + status) are
**done**. Hardware milestones (#1 PN532 read, #2 NDEF-off-a-real-tag, #6 mount, #7 systemd) are
**deferred to step 11**, along with the real reader/LED drivers behind the seams above.

## Consequences

- **CI is green with zero runtime deps** and the whole service runs on a laptop via `--simulate`.
  Verified end-to-end: `python -m stylus --simulate` → `POST /simulate` → state machine → real HTTP
  `start`/`stop` (contract-shaped, `X-Trigger-Secret`) → downstream, with `/status` tracking
  playing→idle.
- **`httpx`/`ndeflib` become optional.** They stay listed as Pi extras for anyone who prefers them,
  but nothing imports them. (A future ADR could drop them from `pyproject` entirely.)
- **Known gap, not silently papered over:** Stylus fans out to Conductor + Backdrop, but **Conductor
  has no `/api/scan`** — it only takes a pre-built palette on `/api/playback` (ADR 0007). Turning a
  raw scan into lights needs Conductor to read the synced asset store (the fan-out model of
  runtime-overview §5). That's a Conductor-side feature, filed as
  [#45](https://github.com/dylanleatham/Marquee/issues/45); Stylus is proven against real Backdrop +
  a stub Conductor in the meantime.
- The retry loop is **synchronous** and runs inline in the poll tick. Fine at this scale (a handful
  of scans per minute, 2.5s max window), but a downstream that's hard-down briefly stalls polling; if
  that ever bites, move publishing to a worker thread — the `Publisher` API doesn't change.
