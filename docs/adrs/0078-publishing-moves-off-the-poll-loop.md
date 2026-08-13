# ADR 0078 — Publishing moves off the poll loop

- **Status:** Accepted
- **Date:** 2026-08-13
- **Issue:** [#173](https://github.com/dylanleatham/Marquee/issues/173)
- **Amends:** [stylus-spec §7](../specs/stylus-spec.md) (LED ack meaning) and
  [§8](../specs/stylus-spec.md) (publish semantics, `/status` shape)
- **Retires a workaround from:** [ADR 0077](0077-the-poll-loop-proves-it-is-alive.md)

## Context

`Publisher.publish` was called synchronously from `StylusApp._handle`, which runs inside `tick()`,
which _is_ the poll loop. So the reader stopped reading for exactly as long as a publish took.

With the shipped timeouts and §8's retry window, one event against unreachable downstreams costs
**~43s**, and a swap publishes twice — **~87s**. Through all of it the stand is blind: lifting the
sleeve isn't noticed, placing a different one isn't noticed. The happy path pays too, about 3s,
which is already longer than the 2s removal debounce.

What makes it worth fixing beyond the raw numbers is how it _presents_. The stand ignores you for
half a minute after a network blip, which reads as a bad antenna or a bad mount — so it sends you
debugging the physical layer, during step 11, which is precisely when you are least able to tell the
difference. #173 was filed from that experience.

It had also started to distort other decisions. [ADR 0077](0077-the-poll-loop-proves-it-is-alive.md)
could not simply beat the systemd watchdog once per tick, because a legitimate tick could take 87s;
it had to thread the heartbeat down into the publisher's retry loop, and pin `WatchdogSec` to a rule
about downstream timeouts. That complexity was entirely a consequence of this bug.

## Decision

**A bounded FIFO queue, drained by one worker thread.** The poll loop submits and returns; the
worker publishes.

1. `stylus/dispatch.py` — `Dispatcher` owns the queue, the worker, health, and stats.
   `run_pending()` drains synchronously, so ordering, the drop rule, health and error handling are
   all testable with no thread involved.
2. `QueuedPublisher` presents the same `publish(event) -> health` surface the app already used, so
   `StylusApp` needs no knowledge of threads. Which publisher it gets is a wiring decision in
   `__main__`. An `EventPublisher` protocol names the shared surface.
3. `__main__` drains the backlog on shutdown before stopping the status server.

### One worker, in order

The thing that must not be concurrent is **events**. A `stop` that overtakes its `start` leaves the
room lit and the video playing with nothing left to correct it. Concurrency between _downstreams_
would be safe, and #173 offered it as a cheaper option — but it addresses the symptom (total time)
rather than the cause (the loop waiting at all), and a single slow downstream would still stall
everything. One worker draining FIFO gives ordering for free.

### Bounded, dropping the oldest

Unbounded, a long outage grows the queue until a Pi Zero runs out of memory. At 64 deep, only a
genuinely sustained outage reaches the bound. When it does, the **stalest** events are the ones to
lose: §8 already requires downstreams to tolerate a missed `stop` by timing out their own state, and
the newest events are the ones that still describe what is on the stand. Drops are counted and
surfaced rather than silent.

### What the watchdog must not do now

This inverts [ADR 0077](0077-the-poll-loop-proves-it-is-alive.md)'s hazard, and getting it wrong
would have quietly undone that ADR. A heartbeat inside `Publisher` now runs on a thread that keeps
going while the reader is wedged — a healthy publisher vouching for a dead poll loop. So the
parameter is **removed from `Publisher` entirely**: the guard is structural, not a comment, because
someone re-adding it in good faith is exactly how this would regress. Two tests assert its absence,
one beside the publisher and one beside the watchdog's own invariants.

The upside is that `WatchdogSec`'s rule gets much easier: the only beat is at the top of `tick()`,
so the gap is one poll interval rather than a downstream timeout. That test now reads
`poll_interval_ms` instead of `timeout_ms`.

## Consequences

- **The reader stays responsive through a network outage.** Worst-case blindness drops from ~87s to
  one poll interval. Raising a downstream `timeout_ms` no longer widens anything the reader feels,
  which was the trap that made #173 worth filing during bring-up.
- **`downstreamHealth` changed meaning.** It is the result of the last _completed_ publish, not of
  `lastEvent`. §8's table says so now. This is the honest cost of asynchrony and there is no way to
  keep the old meaning without keeping the old stall.
- **The LED ack changed meaning**, and this is a deliberate, user-visible choice. §7's two blinks
  meant "successfully published"; they now mean "read and accepted", firing on submission. Gating
  them on the last publish's health would mean a stand that silently stops acknowledging scans it
  accepted perfectly, for as long as a downstream is unwell. Delivery failures still surface — as
  the fast-blink error pattern, which is what that pattern is for.
- **Events can now be dropped.** They could not before; a slow downstream cost time instead. Under
  sustained outage the queue bounds memory by discarding the stalest events. `publishQueue.dropped`
  on `/status` makes that visible, and a warning names it in the journal.
- **`GET /status` gained `publishQueue: { depth, dropped } | null`.** Null only when the publisher has no queue;
  `__main__` always wires one — `--simulate` included — so in practice that means unit-test wiring. Without it, "the lights react late" would have no observable
  cause anywhere — the new failure mode needed a new instrument.
- **Shutdown now waits.** `Dispatcher.stop` drains the backlog with a 10s bound, because the event
  most likely to be queued at shutdown is a `stop`, and losing it leaves the room lit after Stylus
  is gone. If the worker is still busy past the bound it is left behind — a slow shutdown must not
  become a hung one.
- **`Publisher` itself is unchanged**, and still sequential and still slow against dead downstreams.
  That is now the worker's problem rather than the reader's. Fanning out to downstreams
  concurrently remains available as a later refinement, but it is no longer urgent, because nothing
  the user can perceive is waiting on it.
