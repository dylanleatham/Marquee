# ADR 0093 — The stand has a latching off switch

- **Status:** Accepted
- **Date:** 2026-08-16
- **Amends:** [stylus-spec §7](../specs/stylus-spec.md) (a new §7.1 and a fifth LED pattern), §8
  (`switch` on `GET /status`, `POST /switch`), §9 (`[switch]`), and §4's BOM/wiring
- **Touches:** [runtime-overview §5](../specs/runtime-overview.md), [parts-list](../specs/parts-list.md)

## Context

Marquee has no off. Placing a sleeve on the stand is the only way to start the experience, and it is
also the only way to be _in the room with a record on the stand_ — so the lights and the TV change
whether or not that is what you wanted. There is no way to put a record down while someone is
reading, or to leave last night's sleeve on the stand overnight, without the room performing.

The obvious place to look for a fix is the runtime, and it is the wrong place. Conductor, Backdrop
and Amp deliberately share no playback state ("fan-out over centralization",
[runtime-overview §5](../specs/runtime-overview.md)); an off switch there is three switches, or a new
orchestrator to be the single point of failure the architecture was shaped to avoid.

The events all originate from one process. **Stylus is the only place where one interruption
suppresses lights, video and audio at once** — and it is also the place you are standing when you
form the intent, with a Pi, free GPIO pins and a status LED already in it.

Two things then have to be decided: what the switch does to the running state, and what kind of
switch it is.

## Decision

### A switched-off stand shows the state machine an _empty_ stand

`StylusApp.tick()` passes `tag if self._live else None` to `DetectionMachine.observe`. Not a guard
around the publish, not a third machine state — the machine is simply told the stand is empty.

Every behaviour worth having then falls out of debounce logic that already exists and is already
tested:

| You do this                                 | What the existing machine does        | What you see                           |
| ------------------------------------------- | ------------------------------------- | -------------------------------------- |
| Flip off while a record is playing          | removal debounce → ordinary `Stop`    | the room returns to its pre-scan state |
| Put a record down while off                 | nothing — an empty stand stays idle   | nothing                                |
| Flip on with a sleeve already sitting there | insertion debounce → ordinary `Start` | it plays, no lift-and-replace          |
| Flick the switch briefly                    | absorbed by the removal debounce      | nothing                                |

The first row is the one that decided the design. Gating the _publish_ instead would have been the
smaller diff and the wrong behaviour: the `stop` would be suppressed along with everything else, and
the room would freeze on the last record's palette — an "off" switch that leaves the lights doing
the thing you switched it off to stop. Masking the tag gives the room back, and does it through the
same code path that lifting a sleeve already uses. The last row is why no contact debounce is
needed: a mechanical switch settles in well under the 200ms poll interval.

`observed` on `GET /status` still reports the real tag while off, because it describes the _reader_,
not the machine ([#198](https://github.com/dylanleatham/Marquee/issues/198)'s distinction) — "is the
stand off, or is my tag dead?" needs an answer.

### The switch is latching, and its position is the state

A latching toggle/rocker, not a momentary button. The pin level is read at construction and on every
poll; there is no toggle bookkeeping and nothing persisted.

**This is entirely about restarts.** Stylus is restarted by design — `Restart=always`, plus the
§12 watchdog killing a wedged poll loop ([ADR 0077](0077-the-poll-loop-proves-it-is-alive.md)). With
a momentary button, "off" would live in memory, and every one of those restarts would silently
re-arm the room; surviving them would mean a state file, and a state file that disagrees with the
thing on the front of the stand is worse than no switch at all. A latching switch makes the question
unaskable: the position _is_ the state, at boot and at every poll, and it is legible from across the
room without reading an indicator.

`enabled = false` is the config default, so an absent switch reads as permanently live. An absent
switch must never be mistaken for one in the off position.

### Unreadable ⇒ live, and never silently

A GPIO read that throws holds the last known position; a switch that cannot be built at all
(no Blinka, off-Pi) degrades to `AlwaysLive`. A stand that silently refuses to react is
indistinguishable from a broken one, so the failure direction is toward working.

That degradation is the same shape as `create_led`'s, but it is louder — ERROR, not WARNING — and it
is _reported_: `switch.source` on `GET /status` reads `unavailable`, which is what separates "the
switch does nothing" from "the switch is on". Without that field the two are identical over HTTP,
and the failure being debugged would be "I flipped it and the room kept going".

### The LED gets a fifth pattern, and it is not darkness

`OFF` is one 50ms blip every ~4s. Dark would have been simpler and says the wrong thing — a dark LED
is what an unpowered stand looks like, and "switched off" and "dead" must not share an indication.
The dark stretch is eight 0.5s frames rather than one 4s frame because `GpioLed.play_once` only
tests for interruption between frames; a single long frame would leave the LED up to 4s behind the
switch, and flipping the stand back on would look like it hadn't worked.

`OFF` outranks `ERROR`: while off, Stylus publishes nothing, so a stale unhealthy downstream from
before the flip is not what the LED should be shouting about.

All five patterns remain distinguished by _motion_, never colour — a single-channel LED has no
colour to encode with, and `test_every_pattern_is_visually_distinct` now fails if a new pattern
silently inherits another's frames.

## Consequences

- **Off means "the room goes back to normal", not "the room goes dark."** Conductor restores its
  pre-scan snapshot and Backdrop returns to the idle overlay, exactly as when you lift a sleeve. If
  you want the lights actually _off_, that is the Hue app's job, and always was.
- **~2 seconds of latency, by construction.** The `stop` waits out `removal_debounce_polls`
  (10 × 200ms shipped). That is the same delay as lifting the sleeve, which makes it feel like a
  property of the stand rather than a lag.
- **Curator's `simulate-scan` bypasses the switch**, since it posts to Conductor/Backdrop/Amp
  directly. Correct: the room-rehearsal controls are a deliberate admin action taken from another
  room, and are already gated by their own room-arm switch
  ([ADR 0028](0028-preview-bench-and-room-modes.md)).
- **The watchdog is still fed while off.** The heartbeat is the first statement in `tick()`, ahead
  of the switch read — an off stand is idle, not dead, and had the heartbeat ridden along with the
  tag masking, switching off would have become a 30-second restart loop. Asserted by
  `test_the_watchdog_is_still_fed_while_the_stand_is_off`.
- **A pin collision is refused at config load**, not discovered on the stand. GPIO 2/3 (the PN532's
  I²C bus) and the LED's pin are rejected, because sharing one half-works in a way that presents as
  a flaky reader.
- **`POST /switch` exists only with `--simulate-switch`**, and answers `409` otherwise. On the Pi the
  physical switch is the sole authority; an HTTP toggle that a latching switch would snap back on
  the next poll is a control that lies. The simulated switch is what lets the whole off-state be
  exercised on the bench with no GPIO, consistent with `--simulate` and
  [ADR 0016](0016-stylus-stdlib-core-and-hardware-seams.md)'s stdlib-core/hardware-behind-seams rule.
- **One switch, all three services.** A per-surface off (lights on, TV off) was considered and not
  built. It would mean filtering per-downstream inside Stylus, at which point none of the start/stop
  behaviour above falls out for free any more. The seam for it is `_read_switch`, if it is ever
  wanted.
- **`readerId` still scopes everything**, so a second stand gets its own switch rather than
  inheriting this one — consistent with the multi-reader field already in the event shape.
