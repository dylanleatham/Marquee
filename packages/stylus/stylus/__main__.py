"""Entrypoint: ``python -m stylus [--config PATH] [--simulate] [--simulate-switch]``.

Glue only — wiring is covered by the unit tests on each piece. ``--simulate`` runs the bench reader
(drive it via ``POST /simulate``); the default builds the real PN532 reader (Pi only).
``--simulate-switch`` does the same for the stand's §7.1 on/off switch (drive it via
``POST /switch``); the default reads the real GPIO pin, or stays live if none is configured.
"""

from __future__ import annotations

import argparse
import logging
import threading

from .app import StylusApp
from .config import load_config
from .dispatch import Dispatcher, QueuedPublisher
from .led import create_led
from .publisher import Publisher
from .reader import SimulatedReader, TagReader, create_pn532_reader
from .status_server import StatusService, serve
from .switch import SimulatedSwitch, Switch, create_switch
from .watchdog import create_watchdog


def main() -> None:  # pragma: no cover - entrypoint glue
    parser = argparse.ArgumentParser(prog="stylus")
    parser.add_argument("--config", default="config.toml", help="path to config.toml")
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="use the simulated reader (no PN532); drive it via POST /simulate",
    )
    parser.add_argument(
        "--simulate-switch",
        action="store_true",
        help="use a simulated on/off switch (no GPIO); flip it via POST /switch",
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

    sim_switch: SimulatedSwitch | None = None
    switch: Switch
    if args.simulate_switch:
        sim_switch = SimulatedSwitch()
        switch = sim_switch
        log.info("running with a SIMULATED on/off switch — POST /switch to flip it")
    else:
        switch = create_switch(
            config.switch.enabled,
            config.switch.gpio_pin,
            live_when_low=config.switch.live_when_low,
        )
        if config.switch.enabled:
            # The position is read at boot, so an off stand comes back off after a restart — the
            # property that made a latching switch the right part ([ADR 0093]).
            log.info("stand switch: %s at boot", "live" if switch.is_live() else "off")

    # Fed from the poll loop and *only* the poll loop. Publishing runs on its own thread now (#173),
    # so a heartbeat from there would let a healthy publisher vouch for a wedged reader — see
    # stylus/watchdog.py and stylus/dispatch.py.
    watchdog = create_watchdog()

    # The reader must never wait on the network: a publish takes ~43s against dead downstreams, and
    # for all of it the stand would be blind to sleeves coming and going (#173).
    dispatcher = Dispatcher(Publisher(config.downstreams).publish)
    dispatcher.start()

    app = StylusApp(
        config, reader, QueuedPublisher(dispatcher), led, heartbeat=watchdog.ping, switch=switch
    )

    server = serve(StatusService(app, sim, sim_switch), config.status_listen_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info(
        "status server on :%d — fanning out to %s",
        config.status_listen_port,
        ", ".join(d.name for d in config.downstreams) or "(no downstreams configured)",
    )

    # Last, deliberately: under Type=notify this is the promise that startup finished, so it must
    # come after the reader is up and the status port is actually listening. Outside systemd there
    # is no socket and this is a no-op.
    watchdog.ready()

    try:
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        # Before the server, and with a wait: the event most likely to be sitting in the queue at
        # shutdown is a `stop`, and losing that leaves the lights up and the video running with
        # Stylus gone.
        dispatcher.stop()
        server.shutdown()


if __name__ == "__main__":
    main()
