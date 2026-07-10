# Stylus (Python)

Reads NFC-tagged sleeves, publishes scan events to Conductor + Backdrop. Runs on a Pi Zero 2 W.
Spec: [../../docs/specs/stylus-spec.md](../../docs/specs/stylus-spec.md).

Dev: `python -m venv .venv && .venv/Scripts/activate && pip install -e .[dev]` then `pytest`.
Hardware libs (adafruit-pn532) only install on the Pi. Pure-logic (state machine, NDEF, retry)
is testable on your workstation with fakes + freezegun.

**First milestone:** wire the PN532, print tag UIDs. Then NDEF read, state machine, HTTP publish.
