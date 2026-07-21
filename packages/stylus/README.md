# Stylus (Python)

Reads NFC-tagged sleeves and fans scan events out to Conductor + Backdrop. Runs on a Pi Zero 2 W.
Spec: [../../docs/specs/stylus-spec.md](../../docs/specs/stylus-spec.md).

## What's built (step 10 — "on the bench")

The full service, testable and demoable **with no PN532 attached**:

- `config.py` — `config.toml` loader (stdlib `tomllib`), with defaults + validation.
- `ndef.py` — a tiny stdlib NDEF parser: pulls the `curator:album:<id>` URI off an NTAG213.
- `state_machine.py` — the §7 detection FSM (IDLE⇄PLAYING, insertion/removal/swap debounce). Pure.
- `publisher.py` — fan-out HTTP publisher over stdlib `urllib` with the §8 retry window
  (immediate, +500ms, +2s) and the `X-Trigger-Secret` header.
- `reader.py` — `SimulatedReader` (bench) + `create_pn532_reader` (Pi, lazy `adafruit` import).
- `led.py` — semantic LED patterns (idle/playing/error/ack); logs on the bench.
- `status_server.py` — `GET /status`, `GET /healthz`, `POST /simulate` (§8.3).
- `app.py` / `__main__.py` — the poll loop and entrypoint.

The core is **stdlib-only** so it runs anywhere (the Pi's `adafruit`/hardware libs are never imported
off-hardware). See [ADR 0016](../../docs/adrs/0016-stylus-stdlib-core-and-hardware-seams.md).

### Run it on the bench

```sh
python -m stylus --simulate --config config.example.toml
# then, in another shell — pretend a sleeve was placed / lifted:
curl -X POST localhost:4741/simulate -d '{"uid":"04:A1:B2","uri":"curator:album:2k7bxq9m"}'
curl localhost:4741/status
curl -X POST localhost:4741/simulate -d '{"clear":true}'
```

`--simulate` uses the fake reader; `POST /simulate` injects tags. The events fan out to whatever
`[downstream.*]` you configure — point them at a stub, real Backdrop (`/api/scan` exists), or real
Conductor once its scan handler lands (see below).

### Dev

```sh
pip install pytest ruff mypy jsonschema freezegun hypothesis   # what CI installs
pytest -q && ruff check stylus tests && mypy stylus
```

## Deferred to step 11 (physical / hardware)

- The live PN532 read loop + mount + range tuning (`create_pn532_reader` is stubbed for the Pi).
- The real GPIO/PWM LED driver (bench logs the pattern).
- The `systemd` unit + boot integration (`Wants=network-online.target`, restart-on-hang, §12).

## Known dependency: Conductor `/api/scan`

Stylus fans out to both Conductor and Backdrop. **Backdrop's `/api/scan` exists**; **Conductor's does
not yet** — Conductor currently only takes a pre-built palette on `/api/playback` (the Demo Room
proxy, ADR 0007). Turning a raw scan into lights needs Conductor to read the synced asset store. Until
that lands, point `[downstream.conductor]` at a stub. Tracked as
[#45](https://github.com/dylanleatham/Marquee/issues/45).
