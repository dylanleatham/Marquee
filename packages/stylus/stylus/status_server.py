"""The local status HTTP server (stylus-spec §8.3).

* ``GET /healthz``  → 200 when the reader is responding.
* ``GET /status``   → current state, last UID/URI, last event, downstream health.
* ``POST /simulate``→ dev-only: inject a fake tag so you can drive Conductor/Backdrop with no PN532.
  Only available when running the :class:`SimulatedReader` (the bench setup).

Routing lives in :class:`StatusService` (pure, ``handle(method, path, body) -> (status, json)``) so
it's unit-tested without sockets; :func:`serve` is the thin ``http.server`` glue.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .app import StylusApp
from .reader import SimulatedReader


class StatusService:
    def __init__(self, app: StylusApp, sim_reader: SimulatedReader | None = None) -> None:
        self._app = app
        self._sim = sim_reader

    def handle(self, method: str, path: str, body: bytes) -> tuple[int, dict[str, Any]]:
        if method == "GET" and path == "/healthz":
            return 200, {"ok": True}
        if method == "GET" and path == "/status":
            return 200, self._app.status()
        if method == "POST" and path == "/simulate":
            return self._simulate(body)
        return 404, {"error": "not found"}

    def _simulate(self, body: bytes) -> tuple[int, dict[str, Any]]:
        if self._sim is None:
            return 409, {"error": "simulate is only available with the simulated reader"}
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, {"error": "invalid JSON body"}
        if data.get("clear") or data.get("present") is False:
            self._sim.clear()
            return 202, {"simulated": "cleared"}
        uid = data.get("uid")
        if not uid:
            return 400, {"error": "uid is required (or send { clear: true } to lift the sleeve)"}
        self._sim.set_tag(uid, data.get("uri"))
        return 202, {"simulated": {"uid": uid, "uri": data.get("uri")}}


def _make_handler(service: StatusService):
    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self, method: str) -> None:
            length = int(self.headers.get("content-length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            status, payload = service.handle(method, self.path.split("?")[0], body)
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def log_message(self, *args: Any) -> None:  # silence per-request stderr spam
            pass

    return Handler


def serve(service: StatusService, port: int) -> ThreadingHTTPServer:
    """Build (but don't block on) the status server. Caller runs ``serve_forever`` in a thread."""
    return ThreadingHTTPServer(("0.0.0.0", port), _make_handler(service))
