"""The local status HTTP server (stylus-spec §8.3).

* ``GET /healthz``  → 200, plus whether the reader is actually *seeing* tags (``lastReadAt`` /
  ``pollsSinceRead``). It used to be a bare static 200 documented as "200 when the reader is
  responding", which it never checked — a blind reader and a working one were byte-identical here
  for the 40 hours of [#350]. It still answers 200 on a quiet stand, because an empty stand reads
  nothing and that is normal; see :meth:`StylusApp.reader_health`.
* ``GET /status``   → current state, last UID/URI, last event, downstream health.
* ``POST /simulate``→ dev-only: inject a fake tag so you can drive Conductor/Backdrop with no PN532.
  Only available when running the :class:`SimulatedReader` (the bench setup).
* ``POST /switch`` → dev-only: flip the stand's on/off switch (``{"live": false}``). Only available
  when running the :class:`SimulatedSwitch`; on the Pi the physical switch is the sole authority,
  so this answers 409 rather than fighting a latching switch it cannot move ([ADR 0093]).

Routing lives in :class:`StatusService` (pure, ``handle(method, path, body) -> (status, json)``) so
it's unit-tested without sockets; :func:`serve` is the thin ``http.server`` glue.

[#350]: https://github.com/dylanleatham/Marquee/issues/350
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .app import StylusApp
from .reader import SimulatedReader
from .switch import SimulatedSwitch


class _BadBody(Exception):
    """A request body we won't act on. Carries the response to send in its place."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.response: tuple[int, dict[str, Any]] = (400, {"error": message})


class StatusService:
    def __init__(
        self,
        app: StylusApp,
        sim_reader: SimulatedReader | None = None,
        sim_switch: SimulatedSwitch | None = None,
    ) -> None:
        self._app = app
        self._sim = sim_reader
        self._sim_switch = sim_switch

    def handle(self, method: str, path: str, body: bytes) -> tuple[int, dict[str, Any]]:
        # One guard for every route, so an endpoint added later inherits it rather than repeating
        # the bug it exists for (see `_json_object`).
        try:
            return self._route(method, path, body)
        except _BadBody as e:
            return e.response

    def _route(self, method: str, path: str, body: bytes) -> tuple[int, dict[str, Any]]:
        if method == "GET" and path == "/healthz":
            return 200, self._app.reader_health()
        if method == "GET" and path == "/status":
            return 200, self._app.status()
        if method == "POST" and path == "/simulate":
            return self._simulate(body)
        if method == "POST" and path == "/switch":
            return self._switch(body)
        return 404, {"error": "not found"}

    @staticmethod
    def _json_object(body: bytes) -> dict[str, Any]:
        """Parse a request body into a JSON **object**, or raise :class:`_BadBody`.

        Both POST handlers used to call `.get` straight off `json.loads`, which is only safe for an
        object: `[1,2]`, `42`, `"hi"` and `null` all parse fine and none of them have `.get`, so a
        bad request raised `AttributeError` out of `handle()` and killed that request's handler
        thread — a dead thread per attempt, and a bodyless 500 for what is really a 400. Shared here
        so the next endpoint inherits the guard instead of repeating the bug.
        """
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            raise _BadBody("invalid JSON body") from None
        if not isinstance(data, dict):
            raise _BadBody("body must be a JSON object")
        return data

    def _switch(self, body: bytes) -> tuple[int, dict[str, Any]]:
        if self._sim_switch is None:
            return 409, {
                "error": "the stand's switch is physical — flip it (or run with --simulate-switch)"
            }
        live = self._json_object(body).get("live")
        if not isinstance(live, bool):
            return 400, {"error": 'live is required and must be a boolean ({ "live": false })'}
        self._sim_switch.set_live(live)
        return 202, {"switch": {"live": live}}

    def _simulate(self, body: bytes) -> tuple[int, dict[str, Any]]:
        if self._sim is None:
            return 409, {"error": "simulate is only available with the simulated reader"}
        data = self._json_object(body)
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
        # Bound the per-request socket so a client that opens a connection and then stalls mid-body
        # can't tie up a server thread forever (ThreadingHTTPServer spawns one thread per request).
        timeout = 10

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
