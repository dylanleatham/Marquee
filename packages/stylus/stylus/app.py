"""The Stylus app — wires the reader, state machine, publisher, and LED into one poll loop.

``tick()`` is one poll cycle and is the unit the tests drive; ``run()`` just calls it every
``poll_interval_ms``. All action → HTTP/LED effects live here so the state machine stays pure.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from .config import Config
from .events import now_iso, start_event, stop_event
from .led import Led, Pattern
from .publisher import Publisher
from .reader import TagReader
from .state_machine import BadTag, DetectionMachine, Start, State, Stop, Swap

log = logging.getLogger("stylus.app")


class StylusApp:
    def __init__(
        self,
        config: Config,
        reader: TagReader,
        publisher: Publisher,
        led: Led,
        *,
        now: Callable[[], str] = now_iso,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._cfg = config
        self._reader = reader
        self._publisher = publisher
        self._led = led
        self._now = now
        self._sleep = sleep
        self._machine = DetectionMachine(config.reader)
        self._reader_id = config.reader.id
        self._running = False
        # Observability for GET /status.
        self._last_event: dict[str, Any] | None = None
        self._downstream_health: dict[str, bool] = {}
        self._led.set(Pattern.IDLE)

    # --- one poll cycle ---------------------------------------------------------------------------
    def tick(self):
        action = self._machine.observe(self._reader.poll())
        if action is not None:
            self._handle(action)
        self._apply_steady_led()
        return action

    def _handle(self, action) -> None:
        if isinstance(action, Start):
            self._publish(start_event(action.uri, action.uid, self._reader_id, at=self._now()))
            self._ack_start()
        elif isinstance(action, Swap):
            # §7 SWAP: stop the old album, then start the new one. No IDLE in between.
            self._publish(stop_event(self._reader_id, at=self._now()))
            self._publish(start_event(action.uri, action.uid, self._reader_id, at=self._now()))
            self._ack_start()
        elif isinstance(action, Stop):
            self._publish(stop_event(self._reader_id, at=self._now()))
        elif isinstance(action, BadTag):
            log.warning("tag %s carried no valid curator:(album|card) URI — ignoring", action.uid)
            self._led.set(Pattern.ERROR)

    def _ack_start(self) -> None:
        # §7 "two short blinks: I heard you" — only when the start actually reached a downstream.
        # _apply_steady_led then settles to PLAYING (or ERROR) at the end of the tick.
        if not self._last_publish_failed():
            self._led.set(Pattern.START_ACK)

    def _publish(self, event: dict[str, Any]) -> None:
        self._last_event = event
        self._downstream_health = self._publisher.publish(event)

    def _apply_steady_led(self) -> None:
        if self._last_publish_failed():
            self._led.set(Pattern.ERROR)
        elif self._machine.state is State.PLAYING:
            self._led.set(Pattern.PLAYING)
        else:
            self._led.set(Pattern.IDLE)

    def _last_publish_failed(self) -> bool:
        return bool(self._downstream_health) and not all(self._downstream_health.values())

    # --- loop -------------------------------------------------------------------------------------
    def run(self) -> None:  # pragma: no cover - trivial loop, exercised via tick() in tests
        self._running = True
        interval = self._cfg.reader.poll_interval_ms / 1000
        log.info("Stylus polling at %dms (reader=%s)", self._cfg.reader.poll_interval_ms, self._reader_id)
        while self._running:
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — a poll must never kill the loop (§12 PN532 hangs)
                log.exception("poll tick failed — continuing")
            self._sleep(interval)

    def stop(self) -> None:
        self._running = False

    # --- status (GET /status, §8) -----------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        return {
            "state": self._machine.state.value,
            "readerId": self._reader_id,
            "lastUid": self._machine.current_uid,
            "lastUri": self._machine.current_uri,
            "lastEvent": self._last_event,
            "downstreamHealth": self._downstream_health,
        }
