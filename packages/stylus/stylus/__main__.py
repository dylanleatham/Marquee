"""Entrypoint: ``python -m stylus [--config PATH] [--simulate]``.

Glue only — wiring is covered by the unit tests on each piece. ``--simulate`` runs the bench reader
(drive it via ``POST /simulate``); the default builds the real PN532 reader (Pi only).
"""

from __future__ import annotations

import argparse
import logging
import threading

from .app import StylusApp
from .config import load_config
from .led import create_led
from .publisher import Publisher
from .reader import SimulatedReader, TagReader, create_pn532_reader
from .status_server import StatusService, serve


def main() -> None:  # pragma: no cover - entrypoint glue
    parser = argparse.ArgumentParser(prog="stylus")
    parser.add_argument("--config", default="config.toml", help="path to config.toml")
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="use the simulated reader (no PN532); drive it via POST /simulate",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    log = logging.getLogger("stylus")

    config = load_config(args.config)

    sim: SimulatedReader | None = None
    reader: TagReader
    if args.simulate:
        sim = SimulatedReader()
        reader = sim
        log.info("running with the SIMULATED reader — POST /simulate to inject tags")
    else:
        # Logged *before* the call, not after: this is the one step that can hang, and a line that
        # only prints on success tells you nothing about a boot that never got past it (#307).
        log.info("bringing up the PN532 (bound: %dms)", config.reader.init_timeout_ms)
        reader = create_pn532_reader(config.rf, init_timeout_ms=config.reader.init_timeout_ms)
        log.info(
            "PN532 transmit drive: GsNOn=0x%02X CWGsP=0x%02X (chip defaults overcouple — #303)",
            config.rf.gsn_on,
            config.rf.cw_gsp,
        )

    led = create_led(config.led.enabled, config.led.gpio_pin)
    app = StylusApp(config, reader, Publisher(config.downstreams), led)

    server = serve(StatusService(app, sim), config.status_listen_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info(
        "status server on :%d — fanning out to %s",
        config.status_listen_port,
        ", ".join(d.name for d in config.downstreams) or "(no downstreams configured)",
    )

    try:
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        server.shutdown()


if __name__ == "__main__":
    main()
