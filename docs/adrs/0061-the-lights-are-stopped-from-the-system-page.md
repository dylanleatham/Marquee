# ADR 0061 — The lights are stopped from the System page, which is no longer read-only

Status: accepted · Date: 2026-08-08 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§8.5 said the page was read-only apart from **Sync
everything**), [curator-spec.md](../specs/curator-spec.md) (§ the demo routes — `/api/demo/stop` now
has a caller outside the room) · Relates:
[ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (the three places, and the System
page's rewrite), [ADR 0028](0028-preview-bench-and-room-modes.md) (the arm switch, which is what
starts and stops the lights inside the room)

## Context

Curator has been able to stop the lights since [ADR 0028](0028-preview-bench-and-room-modes.md):
`POST /api/demo/stop` proxies Conductor's `/api/playback/stop`, which stops playback and fades the
room back to its pre-session snapshot. The route works and is covered.

**What it has never had is a button you can reach when you need it.** The only two callers are both
inside the room, and both are per-record and gated on the arm switch:

- the arm effect's cleanup — un-arm, or leave the screen, and the lights stop;
- **LIFT THE SLEEVE**, which stops only `if (armed)`.

So the reachable answer to "the lights are on and I want them off" is: pick some record — any record,
it doesn't matter which — open its room, arm the room (which **starts** that record's lights), then
lift the sleeve. Turning the lights off requires turning them on first.

That path is also wrong for the case that actually produces stuck lights. The room is not what put
them there. A sleeve left on the stand, a scan that played and was never lifted, a Conductor holding
a session after Curator's window was closed — none of those started in the room, and none of them
are addressed by a control that lives inside it and only acts while armed.

Meanwhile the **System page already tells you the lights are on.** Its "PLAYING RIGHT NOW" section
has a LIGHTS row naming the record and the pattern, read straight from Conductor. It is the screen
you are already looking at when you form the intent, and it had no way to act on it. The documented
answer was `curl -XPOST .../api/playback/stop` — [docs/runbook.md](../runbook.md) §"Force a service
back to idle" and [docs/failure-drills.md](../failure-drills.md) both spell it out, which is fair
evidence that this is a thing one actually needs to do.

## Decision

**Put the stop in the LIGHTS row of the System page, and change the rule that said it couldn't go
there.**

### 1. The System page is no longer read-only, and the rule it breaks is restated

curator-ui-ux §8.5 said: _"Read-only apart from that button — this is the page you open when
something is wrong, so it must never be the reason something is wrong."_ The **reason** is right and
survives; the **rule** was drawn one notch too tight. The page must never mutate the collection —
a stray click there must not change a record, a palette, or a push — but stopping playback is a
**recovery action**, the same category as **Sync everything**, which the page already carries: it
takes the runtime from a state you did not want to the neutral one, and it is undone by placing a
sleeve.

So §8.5's rule becomes: **the System page writes to the runtime, never to the collection.** Recovery
actions belong here; record edits do not.

Rejected: **a global control in the masthead.** Always reachable, never wrong about where the lights
are — but the masthead is brand, nav, progress and Roadie, and a runtime control there is present on
every screen for an action taken rarely. It would also be stating a fact ("something is playing")
that the masthead does not otherwise know.

Rejected: **make LIFT THE SLEEVE work unarmed.** It is a smaller diff and it is wrong: on the bench
nothing has touched the room, so a button that stopped real lights from bench mode would break the
one guarantee the arm switch exists to make.

### 2. The button is offered whenever Conductor answers — not only when a light is showing

The obvious gate is `lights.length > 0`. It is wrong, and the page says so three lines below in its
own caveat: Conductor's playback view **covers only CLIP playback**, so an album on a streaming
pattern reports nothing while genuinely lighting the room. Gating on `lights` would hide the control
in exactly the case the page admits it is blind to — a room that is lit, a row that says "nothing",
and no way to act.

The one gate kept is **Conductor reachable**. With Conductor down the stop can only 502, and the
service list directly above already says which service is not answering and why.

### 3. Both outcomes are a sentence, including success

A stop pressed while the row already read "nothing" changes nothing on screen. Left silent, a
correct stop and a broken button look identical. So the result is stated in words either way — "The
lights are off — the room is back to how it was." or "Couldn't stop the lights: …" — in the prose
slot the section already uses for what it cannot put in a row. Wording carries the difference before
colour does (§3.4).

## Consequences

- **The lights can be stopped without first starting them.** The room's arm-and-lift path is
  untouched and stays the right control while you are in the room watching a record.
- **§8.5's "read-only" claim is retired**, replaced by "writes to the runtime, never to the
  collection". Any future control proposed for this page is measured against that line instead.
- **The stop is room-wide, not per-record**, because Conductor's stop is: it takes a `roomId` and
  defaults to the configured listening room. There is no "stop just this album", and the button does
  not imply one.
- **A stop with no listening room configured returns Conductor's 400** ("no room specified and no
  listening room configured"), which surfaces verbatim as the failure sentence. That is the
  actionable text, and it points at the room picker the room screen offers.
- **Not addressed: the screen and the sound.** "Playing right now" also lists SCREEN and SOUND, and
  neither has a stop here. The lights are the one that stays on and bothers a room; adding the other
  two on the strength of symmetry alone would be three controls where one was asked for. Worth
  revisiting when either actually strands.
