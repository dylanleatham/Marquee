# ADR 0077 — The poll loop proves it is alive

- **Status:** Accepted
- **Date:** 2026-08-13
- **Issue:** [#308](https://github.com/dylanleatham/Marquee/issues/308)
- **Completes:** [ADR 0076](0076-a-hung-pn532-init-becomes-a-restart.md), which bounded the one-time
  init and named this half as explicitly out of scope
- **Amends:** the "PN532 hangs" bullet in [stylus-spec §12](../specs/stylus-spec.md)

## Context

[ADR 0076](0076-a-hung-pn532-init-becomes-a-restart.md) converted a hung PN532 _init_ into a process
exit, which `Restart=always` recovers. It left the loop uncovered, and said so.

The uncovered case is a wedged module _after_ init — blocked in `read_passive_target`, or in an
`ntag2xx_read_block` partway through an NDEF read. The symptom is identical to the one 0076 fixed:
`active (running)`, silent journal, nothing read, and `Restart=` never firing because a blocked
process is not a dead one.

0076's tool doesn't transfer. A thread with a join timeout works for init because init happens once,
at a known moment. Per-poll it would mean a thread every 200ms, and the wedged ones can't be killed
(they're in a C-level I²C ioctl), so they'd accumulate until the process died of something
unrelated. **A loop needs a signal that keeps arriving, not a bound on a single call.**

systemd already implements exactly that: `WatchdogSec=` in the unit, `WATCHDOG=1` on the socket named
by `$NOTIFY_SOCKET`. It costs no dependency — the protocol is a datagram.

### The hard part is the false positive

`Publisher.publish` runs **inside** `StylusApp.tick()`, synchronously, and §8's retry window is
three attempts per downstream with 2.5s of sleeps. With the shipped timeouts that is 43.5s per
publish during a total outage, and a **swap** publishes twice — **~87s** in a single legitimate tick.
This is the known [#173](https://github.com/dylanleatham/Marquee/issues/173).

So the naive implementation — ping once per tick, `WatchdogSec=30` — would kill Stylus whenever
**Conductor** was down. That trade is strictly negative: restarting Stylus does nothing for a downed
Conductor, and it discards the state machine. A watchdog that fires on the wrong failure is worse
than no watchdog, because it manufactures outages out of unrelated ones.

## Decision

**The heartbeat measures process liveness, not tick completion**, and is threaded down into the slow
call rather than wrapped around it.

1. `stylus/watchdog.py` — `notify_address` (translating systemd's `@` back into the abstract
   namespace's leading NUL), `watchdog_interval_s` (half of `WATCHDOG_USEC`, honouring
   `WATCHDOG_PID`), and a `Watchdog` with `ready()` / `ping()`. `ping()` is rate-limited to the
   interval, so callers may say "still alive" as often as they like.
2. The unit becomes `Type=notify` with `WatchdogSec=30`. `READY=1` is sent once the reader is up and
   the status port is listening.
3. `StylusApp.tick()` beats first, before anything that can block.
4. **`Publisher` takes the same heartbeat and beats once per attempt.** This is the load-bearing
   part. It reduces the longest gap between beats from "a whole tick" (~87s worst case) to "one
   transport timeout plus one retry delay" (~7s), which is what makes a 30s deadline safe.

Everything touching the outside — `os.environ`, the socket — is injected, so the protocol is tested
on machines with no systemd at all (and on Windows, where `AF_UNIX` datagrams don't exist).

### The interval arithmetic, and why it's a test

Stylus pings at `WatchdogSec/2`, so a beat is only _sent_ on the first call after the interval
elapses. The real constraint is therefore:

> the longest gap between heartbeat **calls** must stay under `WatchdogSec/2`

Shipped: 5s (largest `timeout_ms`) + 2s (longest retry delay) = 7s, against a 15s ping interval.

That is a coupling between a `.service` file, `config.example.toml`, and a constant in
`publisher.py` — three files, no compiler, and a failure that only appears when a downstream happens
to be down. So it is asserted: `test_watchdogsec_clears_the_slowest_legitimate_gap_between_heartbeats`
computes the worst gap from `config.example.toml` and `DEFAULT_RETRY_DELAYS` and fails if
`WatchdogSec` doesn't clear twice it. Raising a downstream `timeout_ms` past ~12s now turns the
suite red instead of arming a time bomb.

## Consequences

- **Both halves of the hang story are closed.** Init exits (0076); the loop trips the watchdog
  (here). The `active (running)` and silent symptom should no longer be reachable, and DEPLOY.md §12
  now treats seeing it as evidence the watchdog isn't armed — with the command to check.
- **The unit and the code are now a matched pair.** `Type=notify` against a checkout that doesn't
  send `READY=1` hangs in `activating` until `TimeoutStartSec` kills it. The reverse is harmless.
  DEPLOY.md §13 carries the warning, since "update the unit, forget the venv" is a plausible deploy
  slip and the failure looks nothing like its cause.
- **`WatchdogSec=30` is a compromise, not a derived optimum.** It's ~4× the worst legitimate gap and
  ~2× the ping interval, so a real hang is caught within 30s. Fixing
  [#173](https://github.com/dylanleatham/Marquee/issues/173) — bounding total publish time — would
  let it tighten considerably, and would also stop the reader being blind for ~87s, which is a
  defect in its own right. This ADR does not fix that; it stops it being fatal.
- **A tick that raises every time still counts as alive.** The beat is at the top of `tick()` and
  `run()` swallows exceptions, so a reader failing on every poll keeps the service up rather than
  restarting it. That is deliberate — the loop _is_ executing, the journal fills with tracebacks,
  and DEPLOY.md §12 already routes "repeated read failures" to power-cycling the module. The
  watchdog answers "is this process executing?", and nothing else.
- **A cosmetic fault can't become a real one.** `Watchdog._emit` swallows `OSError`: failing to
  _report_ health must never become the outage it was reporting on. The notify socket is also
  **non-blocking**, for the sharper version of the same problem — the send now sits inside the poll
  tick and the publish retry loop, so a full receive buffer on a blocking socket could stall the
  loop the watchdog exists to prove is running. Non-blocking turns that into a `BlockingIOError`
  that is logged and dropped; losing a ping is safe when they're sent at half the deadline.
- **The seam is small and injected**, so `stylus/watchdog.py` is fully tested off-hardware — 23
  tests covering the environment parsing, the rate limiting, and the unit-file agreement. Consistent
  with [ADR 0016](0016-stylus-stdlib-core-and-hardware-seams.md): stdlib core, hardware and platform
  behind injectable seams.
