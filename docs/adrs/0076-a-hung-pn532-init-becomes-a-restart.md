# ADR 0076 — A hung PN532 init becomes a restart

- **Status:** Accepted
- **Date:** 2026-08-12
- **Issue:** [#307](https://github.com/dylanleatham/Marquee/issues/307)
- **Amends:** the "PN532 hangs" bullet in [stylus-spec §12](../specs/stylus-spec.md)
- **Follows:** [ADR 0075](0075-stylus-drives-the-pn532-below-its-default-power.md), which added the
  fourth unprotected call to the sequence this ADR bounds

## Context

Stylus' one-time PN532 bring-up made four calls, none of them bounded:

1. `busio.I2C(board.SCL, board.SDA)`
2. `PN532_I2C(i2c, debug=False)`
3. `pn532.SAM_configuration()`
4. `configure_tx_drive(pn532.call_function, …)` — added by [ADR 0075](0075-stylus-drives-the-pn532-below-its-default-power.md)

Any of them can block forever against a wedged module or an I²C bus that never releases.

**A hang is a worse failure than a crash, because systemd cannot see it.** `marquee-stylus.service`
has `Restart=always`, which recovers a process that _exits_. A process blocked inside a C extension
never exits, so the unit sits at `active (running)` with a silent journal, reading nothing,
indefinitely. The health signal reports the opposite of the truth, and the only recovery is a human
noticing the stand is dead and SSHing in.

DEPLOY.md §12 had documented this symptom — _"Service is `active (running)` but the log is silent
and no tag ever reads … a hang inside the one-time PN532 init doesn't exit, so `Restart=` can't
catch it"_ — for as long as the init has existed. The failure was known, written down, and
unrecovered: the runbook's advice was "restart it yourself".

The review of [#305](https://github.com/dylanleatham/Marquee/pull/305) flagged call 4 as it was
being added. Bounding only the newest of four equally-exposed calls would have read as protection
while leaving the two calls DEPLOY.md actually names wide open, so it was deferred here rather than
done partially.

## Decision

**The entire init runs under a time bound, and exceeding it exits the process.**

1. `stylus/bounded.py` provides `call_with_timeout(work, timeout_s, stage=…)` — runs `work` on a
   daemon thread, joins with a timeout, raises `Hung(stage, timeout_s)` if it doesn't finish — and
   `run_or_die(…)`, which logs the reason at CRITICAL and calls `os._exit(1)`.
2. `reader.open_pn532_reader(connect, rf, …)` takes the chip **constructor** as an injected
   callable, so the bound covers construction as well as configuration. This is why it exists as a
   separate function rather than the bound living inside `build_pn532_reader`: calls 1 and 2 happen
   before there is a chip object to configure, and they are the two DEPLOY.md names.
3. The bound is a config knob, `[reader] init_timeout_ms`, defaulting to 10s.
4. `create_pn532_reader` keeps only the lazy imports and a `connect` closure it hands to
   `open_pn532_reader`.

### Why the thread is never killed

It can't be. The hung call is blocked in a C-level I²C ioctl, where the interpreter never regains
control — there is no interrupt to deliver, no cancellation to request, no timeout to pass down.
The worker is a daemon thread and the process leaves without it.

That is also why the exit is `os._exit(1)` rather than `sys.exit(1)`. A normal shutdown runs
`atexit` hooks and flushes buffers while a wedged file descriptor is still held, so the process
trying to die _of_ a hang can hang on its way out — the fix becoming the bug. `os._exit` is
unconditional. The consequence is that nothing after it runs, which is why the explanation is
logged **before** it: `os._exit` skips buffered output, and a restart with no reason in the journal
is this same blindness one level up.

### Why not `WatchdogSec` + `sd_notify`

The considered alternative was `Type=notify` with `WatchdogSec=`, pinging `WATCHDOG=1` from the poll
loop. It is strictly broader — it covers a hang in the **poll loop**, which this decision does not —
and it was rejected only for _this_ change, not on the merits:

- It doesn't subsume the init bound. Init happens before the loop can ping anything, so covering
  init under a watchdog means `Type=notify` plus a `READY=1` handshake plus a startup timeout —
  a larger change to how the unit starts, in a PR whose job is to close a documented hole.
- It only works under systemd. Bench and `--simulate` runs have no `$NOTIFY_SOCKET`, so it needs a
  no-op path, and the protection cannot be tested the way the thread bound can.
- The thread bound names what hung. `PN532 init did not complete within 10s` is a better first line
  of a debugging session than a watchdog kill.

The poll-loop half is filed as [#308](https://github.com/dylanleatham/Marquee/issues/308) with the
design sketched, and `WatchdogSec` is the right tool there. The two compose; this is not a fork in
the road.

## Consequences

- **A wedged module now self-recovers.** The stand comes back on its own instead of waiting for
  someone to notice. If the module is genuinely dead the service restart-loops, which is loud in
  `systemctl status` — the intended outcome, and far better than looking healthy.
- **The default bound is generous on purpose.** A healthy init is well under a second; 10s leaves a
  wide margin because the failure mode of a _tight_ bound is a boot loop on a slow-but-working
  module, which is worse than the hang it guards. Hence the config knob, and hence the runbook
  saying "raise it before suspecting it".
- **A poll-loop hang presents identically and is still uncovered.** DEPLOY.md §12 keeps a row for
  that symptom, now pointing at [#308](https://github.com/dylanleatham/Marquee/issues/308) rather
  than describing the init. Saying so plainly is the point: the fix is partial, and a runbook that
  implied otherwise would cost someone a debugging session.
- **The blind spot is closed structurally.** The defect lived in the `# pragma: no cover` hardware
  factory — the same seam as [#170](https://github.com/dylanleatham/Marquee/pull/170),
  [#174](https://github.com/dylanleatham/Marquee/pull/174),
  [#176](https://github.com/dylanleatham/Marquee/pull/176),
  [#232](https://github.com/dylanleatham/Marquee/pull/232) and
  [#303](https://github.com/dylanleatham/Marquee/issues/303). Injecting `connect` and `exit_` moves
  the whole composition under test: a fake that hangs on each of the four sites in turn asserts the
  process exits non-zero, so a future call added to the sequence _outside_ the bound is a test
  failure rather than a field report. That test was watched failing against an unbounded
  `open_pn532_reader` before the bound was written — all four sites red, which is the evidence the
  tests detect the actual bug and not merely their own scaffolding.
- **`os._exit` is now in the codebase**, and it is a sharp tool: no cleanup, no finalizers, no
  flush. It is confined to `run_or_die`, reached only on a hang, and injected in tests so nothing
  else acquires the habit.
