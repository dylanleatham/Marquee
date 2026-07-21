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
from .reader import SimulatedReader, create_pn532_reader
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
    if args.simulate:
        sim = SimulatedReader()
        reader = sim
        log.info("running with the SIMULATED reader — POST /simulate to inject tags")
    else:
        reader = create_pn532_reader()

    app = StylusApp(config, reader, Publisher(config.downstreams), create_led(config.led.enabled))

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
