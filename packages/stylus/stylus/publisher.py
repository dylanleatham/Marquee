"""Fan-out HTTP publisher (stylus-spec §8).

Posts each scan event to every configured downstream (Conductor, Backdrop) with the
``X-Trigger-Secret`` header, using a short fire-and-forget retry window: immediate, +500ms, +2s,
then give up and log. A scan that lands 30s late is worse than not landing at all (§8), so the
window is deliberately tiny.

The transport (default: stdlib ``urllib``) and ``sleep`` are injectable so tests drive the retry
logic with a fake and without real sockets or real waiting — and so the tested path needs no
third-party HTTP library (CI installs none).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from typing import Any

from .config import Downstream

log = logging.getLogger("stylus.publisher")

# (url, body, headers, timeout_seconds) -> HTTP status code. Raises on a network/timeout failure.
Transport = Callable[[str, bytes, dict[str, str], float], int]
Sleep = Callable[[float], None]

# Seconds to wait *before* attempts 1/2/3 (§8: immediate, +500ms, +2s).
DEFAULT_RETRY_DELAYS: tuple[float, ...] = (0.0, 0.5, 2.0)


def urllib_transport(url: str, body: bytes, headers: dict[str, str], timeout_s: float) -> int:
    """POST via the stdlib. Maps an HTTP error response to its status code (so non-2xx retries);
    lets connection/timeout errors propagate (so the publisher counts them as a failed attempt)."""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as e:  # 4xx/5xx — a real response, just not success
        return int(e.code)


class Publisher:
    def __init__(
        self,
        downstreams: Sequence[Downstream],
        *,
        transport: Transport = urllib_transport,
        sleep: Sleep | None = None,
        retry_delays: Sequence[float] = DEFAULT_RETRY_DELAYS,
    ) -> None:
        import time

        self._downstreams = tuple(downstreams)
        self._transport = transport
        self._sleep: Sleep = sleep or time.sleep
        self._retry_delays = tuple(retry_delays)

    def publish(self, event: dict[str, Any]) -> dict[str, bool]:
        """Send ``event`` to every downstream. Returns ``{name: delivered?}``; never raises."""
        return {d.name: self._send_with_retry(d, event) for d in self._downstreams}

    def _send_with_retry(self, d: Downstream, event: dict[str, Any]) -> bool:
        body = json.dumps(event).encode("utf-8")
        headers = {"content-type": "application/json"}
        if d.shared_secret:
            headers["X-Trigger-Secret"] = d.shared_secret
        timeout_s = d.timeout_ms / 1000
        last: str = "no attempts"
        for delay in self._retry_delays:
            if delay:
                self._sleep(delay)
            try:
                status = self._transport(d.url, body, headers, timeout_s)
            except Exception as e:  # noqa: BLE001 — a wedged network is exactly what we retry past
                last = f"{type(e).__name__}: {e}"
                continue
            if 200 <= status < 300:
                return True
            last = f"HTTP {status}"
        log.warning(
            "gave up posting %s to %s (%s) after %d attempts: %s",
            event.get("event"),
            d.name,
            d.url,
            len(self._retry_delays),
            last,
        )
        return False
