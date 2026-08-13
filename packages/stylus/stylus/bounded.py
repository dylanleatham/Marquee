"""Bounding a call that can hang (stylus-spec §12, [ADR 0076]).

A hang is a worse failure than a crash, because systemd can't see it. ``Restart=always`` recovers a
process that *dies*; a process blocked forever inside a C extension stays ``active (running)`` with
a silent journal, and the health signal reports the opposite of the truth. That is exactly what a
wedged PN532 does to Stylus' one-time init
([#307](https://github.com/dylanleatham/Marquee/issues/307)).

This module converts the one into the other: run the risky call on a thread, and if it doesn't
finish in time, exit so the unit's existing restart policy takes over.

**The worker thread is never killed, because it can't be.** It's blocked in a C-level I²C ioctl,
where Python's interpreter never regains control — there is no interrupt, no cancel, no timeout to
pass down. The thread is a daemon and the process leaves without it. That is also why the exit is
``os._exit`` rather than :func:`sys.exit`: a normal shutdown runs finalizers and flushes buffers
while holding a wedged file descriptor, so the process trying to die of a hang can hang on its way
out. See :func:`run_or_die`.

[#307]: https://github.com/dylanleatham/Marquee/issues/307
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

log = logging.getLogger("stylus.bounded")


class Hung(TimeoutError):
    """A bounded call didn't finish in time.

    Carries ``stage`` rather than only a message so a caller can say *which* step wedged. The
    journal line it produces is the whole diagnostic for a restart that would otherwise be silent.
    """

    def __init__(self, stage: str, timeout_s: float) -> None:
        super().__init__(f"{stage} did not complete within {timeout_s:g}s")
        self.stage = stage
        self.timeout_s = timeout_s


def call_with_timeout(work: Callable[[], T], timeout_s: float, *, stage: str) -> T:
    """Run ``work`` on a daemon thread; raise :class:`Hung` if it outlasts ``timeout_s``.

    Returns whatever ``work`` returns, and re-raises whatever it raises — an init that *fails* is
    already handled (the exception ends the process and systemd restarts it), so only the hang gets
    special treatment.

    The bound is on *our* patience, not on the call: a hung ``work`` is still running when this
    returns, and nothing here can stop it.
    """
    box: dict[str, object] = {}

    def run() -> None:
        try:
            box["value"] = work()
        except BaseException as e:  # noqa: BLE001 — re-raised on the calling thread below
            box["error"] = e

    thread = threading.Thread(target=run, name=f"bounded:{stage}", daemon=True)
    thread.start()
    thread.join(timeout_s)
    if thread.is_alive():
        raise Hung(stage, timeout_s)
    if "error" in box:
        raise box["error"]  # type: ignore[misc]
    return box["value"]  # type: ignore[return-value]


def run_or_die(
    work: Callable[[], T],
    timeout_s: float,
    *,
    stage: str,
    exit_: Callable[[int], None] = os._exit,
) -> T:
    """:func:`call_with_timeout`, but a hang ends the process instead of raising into a caller.

    A hang has no recovery inside this process — the bus is held by a thread that will never come
    back — so the honest response is to leave and let ``Restart=always`` bring up a fresh one
    against a module that gets a fresh chance to answer.

    The reason is logged **before** exiting: ``os._exit`` skips atexit hooks and buffered output, so
    anything said afterwards would never reach journald, and the operator would see a restart with
    no explanation — the same blindness one level up.

    ``exit_`` is injected only so tests can assert the exit happens without taking the suite down
    with it. It really is ``os._exit`` in production, and the ``raise`` after it is unreachable
    there; it keeps the function honest for a hook that returns.
    """
    try:
        return call_with_timeout(work, timeout_s, stage=stage)
    except Hung as e:
        log.critical(
            "%s — exiting so systemd restarts us. The call is blocked in the driver and cannot be "
            "interrupted; if this recurs, power-cycle the module.",
            e,
        )
        exit_(1)
        raise
