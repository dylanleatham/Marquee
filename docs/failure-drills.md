# Failure drills — the step-12 hardening pass

The tick-along companion to [`bring-up-checklist.md`](bring-up-checklist.md), one step later.
The checklist proves the system works when everything is up; this proves it **degrades the way
[runtime-overview §9](specs/runtime-overview.md#9-failure-modes-curated-list) says it does** when
something is down. That's runtime-overview §10 **step 12**
([issue #53](https://github.com/dylanleatham/Marquee/issues/53)).

**Why drills and not just tests.** Every row below already has a unit test — the "Covered by" column
names it. A passing unit test proves the _logic_ handles the failure; it says nothing about whether
the failure reaches that logic on real hardware. #52 found four bugs that lived entirely in the gap
between those two statements, every one inside a `pragma: no cover` seam. A drill closes that gap by
inducing the real failure against the real deployment and watching what the room does.

**How to use it.** Drills are independent — run one, run all ten. Each says what to break, the exact
command, and the **observable** that decides pass/fail. Record the result in the table at the bottom;
a drill you didn't run is not a drill that passed. Anything that fails is a bug: file it and follow
[the bug-fix workflow](specs/bug-fix-workflow.md).

---

## Setup

The same exports as the bring-up checklist, plus Curator's host:

```sh
export SECRET='<your-lan-secret>'
export URI='curator:album:<curatorId>'
export PI5=marquee-pi5
export PIZERO=marquee-pizero
export CURATOR=<your-workstation-hostname>
```

| Service   | Host       | Port   | Health                    |
| --------- | ---------- | ------ | ------------------------- |
| Conductor | `$PI5`     | `4737` | `GET /healthz`            |
| Curator   | `$CURATOR` | `4739` | Curator UI → **System**   |
| Backdrop  | `$PI5`     | `4740` | `GET /healthz`            |
| Amp       | `$PI5`     | `4741` | `GET /healthz`            |
| Stylus    | `$PIZERO`  | `4741` | `GET /healthz`, `/status` |

Two commands you'll reuse in most drills:

```sh
curl -s -XPOST http://$PI5:4737/api/scan -H "X-Trigger-Secret: $SECRET" -H 'content-type: application/json' -d "{\"event\":\"start\",\"uri\":\"$URI\",\"tagUid\":\"04:A1\",\"at\":\"$(date -Is)\"}"
```

```sh
curl -s -XPOST http://$PI5:4737/api/scan -H "X-Trigger-Secret: $SECRET" -H 'content-type: application/json' -d "{\"event\":\"stop\",\"at\":\"$(date -Is)\"}"
```

> **Read the response body, not just the status.** A `202` from `/api/scan` can mean _playing_ or
> _ignored, and here's why_ — `action` and `reason` are the fastest signal in the whole system.

---

## D1 — Lost `stop` event → the idle timeout restores the room

**§9 row:** Lost `stop` event. **Covered by:** `hue-conductor/test/engine.test.ts`,
`backdrop/test/controller.test.ts` (fake timers). **What the drill adds:** that the restore reaches
real bulbs — the snapshot is taken from the live bridge, so "restores idle" on a fake and "the lamps
go back to how they were" are different claims.

Ninety minutes is too long to sit through, so shorten it for the drill. On the Pi 5, in both
`hue-conductor/config.toml` and `backdrop/config.toml`:

```toml
[runtime]
idle_timeout_minutes = 2
```

```sh
sudo systemctl restart marquee-conductor marquee-backdrop
```

1. Note what the lamps look like **before** anything (this is what the snapshot must restore to).
2. Fire a `start` scan (above). Lights + video become the record.
3. **Do not** send `stop`. Wait out the timeout.

**Observable:** within ~2 min the lights return to their pre-scan state and the video fades to the
idle overlay, with no command sent. Then:

```sh
curl -s http://$PI5:4737/api/playback/current   # → no active session
curl -s http://$PI5:4740/api/status             # → "state":"idle"
```

**Fails if:** the lights land on some _other_ state (a bad snapshot, not a bad timer — the more
likely bug of the two), or either service still reports playing.

**Manual override**, if you ever need it without waiting:

```sh
curl -s -XPOST http://$PI5:4737/api/playback/stop -H "X-Trigger-Secret: $SECRET" -H 'content-type: application/json' -d '{}'
curl -s -XPOST http://$PI5:4740/api/admin/stop -H "X-Trigger-Secret: $SECRET"
```

**Put `idle_timeout_minutes` back to 90 and restart both services when you're done.**

---

## D2 — Hue bridge unreachable → clean 502, and the next scan recovers

**§9 row:** Hue bridge unreachable. **Covered by:** `hue-conductor/test/server.test.ts` — _"bridge
unreachable → 502, lights untouched, and the next scan recovers"_. **What the drill adds:** that a
real bridge outage looks like a refused connection and not a 30-second hang. A hang is the failure
mode that matters here, because Stylus is blocking on this call
([#173](https://github.com/dylanleatham/Marquee/issues/173)).

1. Pull power on the Hue bridge (or drop it off the LAN).
2. `curl -s http://$PI5:4737/api/bridge/status` → `{"paired":true,"reachable":false}`.
3. Fire a `start` scan. **Time it.**

**Observable:** a `502` with an error body, **within a couple of seconds** — not a hang. Backdrop is
unaffected: the video still plays, because the fan-out is per-service.

4. Power the bridge back on, wait for it to come up, fire the same scan again.

**Observable:** `202 {"action":"playing"}` and the lights change. No Conductor restart, no manual
clear.

**Fails if:** the scan hangs past ~5s (a missing timeout on the bridge call), or the recovery scan
still errors (a latched failure — a cached dead connection that nothing invalidates).

---

## D3 — Video file missing on Backdrop's SD → indicator, never a black screen

**§9 row:** Video file missing. **Covered by:** `backdrop/test/controller.test.ts`. **What the drill
adds:** the indicator on the actual TV, at actual size, from actual couch distance.

Pick an album whose video is on the Pi and move it aside:

```sh
ssh $PI5 'cd /home/pi/marquee-data/media/visualizers && mv <curatorId>.mp4 <curatorId>.mp4.hidden'
curl -s http://$PI5:4740/api/library | grep -o '"fileMissing":true' | head
```

Then scan that album (`POST /api/scan`, or place the sleeve).

**Observable:** the display **stays on whatever it was showing** — idle overlay or the previous clip
— and flashes `video file missing` center-bottom for ~4s. No black screen, no crash. `GET
/api/status` still reports the previous state.

**Fails if:** the screen goes black, the browser reloads, or the indicator never appears (check the
kiosk URL has `?debug=1` if indicators are hidden — see
[backdrop-spec §10](specs/backdrop-spec.md#10-frontend-spa-structure)).

Restore the file afterwards, or re-push it from Curator.

---

## D4 — Album not in Backdrop's library → indicator, stays put

**§9 row:** Album not in library. **Covered by:** `backdrop/test/controller.test.ts`. **What the
drill adds:** the case backdrop-spec §13 calls out as happening more than you think — you'll write
tags before you generate videos.

```sh
curl -s -XPOST http://$PI5:4740/api/admin/simulate-scan -H "X-Trigger-Secret: $SECRET" -H 'content-type: application/json' -d '{"event":"start","uri":"curator:album:zzzzzzzz","tagUid":"04:FF","at":"2026-01-01T00:00:00Z"}'
```

**Observable:** `202`, the display stays put, and `video not in library` flashes center-bottom. The
Backdrop log carries the URI it couldn't resolve.

**Fails if:** the two indicators are indistinguishable from each other in practice — they point at
different fixes (D3 = re-sync the file, D4 = attach a video in Curator), so if you can't tell them
apart from the couch, that's a real finding.

---

## D5 — Stylus can't reach a downstream → 3 retries, log, fast-blink LED

**§9 row:** Stylus can't reach Conductor. **Covered by:** `stylus/tests/test_publisher.py`,
`test_led.py`. **What the drill adds:** the LED. Its pattern is the only feedback the stand gives
you, and it has never been judged by eye on the real board.

1. Stop one downstream: `ssh $PI5 'sudo systemctl stop marquee-conductor'`.
2. Place the sleeve (or `POST /simulate` on `$PIZERO:4741`).

**Observable:**

- The stand's LED goes to a **fast 100ms blink** and stays there.
- `journalctl -u marquee-stylus -f` shows one `gave up posting start to conductor … after 3 attempts`
  — **one** line, not a flood.
- The whole give-up takes ~2.5s of retry window plus the per-attempt timeout.
- Backdrop **still plays**: one downstream being down must not suppress the others.

```sh
curl -s http://$PIZERO:4741/status   # downstreamHealth → conductor false, backdrop true
```

3. `sudo systemctl start marquee-conductor`, lift and re-place the sleeve.

**Observable:** LED back to its playing pattern, `downstreamHealth.conductor` true.

**Fails if:** the LED is ambiguous by eye (fast-blink vs. the idle breathe should be unmistakable at
a glance — this is exactly the polish the issue asks for), or the reader stops responding to a
sleeve lift while the retry window is open ([#173](https://github.com/dylanleatham/Marquee/issues/173) —
expected today, so note the duration rather than filing it again).

---

## D6 — Bad JSON in an asset file → Conductor logs and stays idle

**§9 row:** Bad JSON in asset file. **Covered by:** `hue-conductor/test/assets.test.ts` (_"returns
null (not throw) on a corrupt file"_), plus Curator's save-side validation. **What the drill adds:**
that a corrupt file on the Pi degrades to "album not synced" rather than taking the service down —
the asset store is the one thing every scan reads.

```sh
ssh $PI5 'cp /home/pi/marquee-data/album-assets/<curatorId>.json /tmp/good.json && echo "{ this is not json" > /home/pi/marquee-data/album-assets/<curatorId>.json'
```

Fire a `start` scan for that album.

**Observable:** `202 {"action":"ignored","reason":"album not synced"}`, a warning in
`journalctl -u marquee-conductor`, lights unchanged, **service still running**. A scan for a
_different_, healthy album immediately afterwards works normally.

**Fails if:** Conductor 500s, crashes, or the corrupt album poisons subsequent scans.

Then confirm the write side: try to save that album in Curator's UI.

**Observable:** Curator refuses the save with a validation error rather than writing it. Restore with
`cp /tmp/good.json /home/pi/marquee-data/album-assets/<curatorId>.json`.

---

## D7 — Sync verification tells the truth about drift

**§9 row:** — (this is the issue's "sync verification" bullet). **Covered by:**
`curator/test/backdrop-sync.test.ts`. **What the drill adds:** that the drift report matches what's
_actually_ on the Pi. This is the exact class of bug that let six albums sit behind the workstation
for four days ([ADR 0045](adrs/0045-curator-pushes-album-assets-to-conductor.md)) — a sync path that
reported success while moving nothing.

> **The issue text is stale here.** #53 asks about "the rsync-to-Conductor path"; ADR 0045 replaced
> it with an HTTP push (`PUT /api/album-assets/:curatorId`). Drill the push.

**Backdrop side:**

```sh
curl -s -XPOST http://$CURATOR:4739/api/backdrop/verify-sync -H 'content-type: application/json'
```

Compare its verdict against the truth on the Pi:

```sh
curl -s http://$PI5:4740/api/library
ssh $PI5 'ls -la /home/pi/marquee-data/media/visualizers'
```

**Observable:** every album `verify-sync` calls missing really is missing, and every album it calls
present really has bytes on the SD card. Now induce drift — delete one video on the Pi and re-run
verify-sync — and confirm it **notices**.

**Conductor side:** delete one album's JSON from `/home/pi/marquee-data/album-assets` on the Pi, then push the
library from Curator (**System → sync**, or `POST /api/runtime/sync`) and confirm the file comes
back.

**Fails if:** a report says "in sync" while the two directories differ. A sync tool that lies is
worse than no sync tool — you'd stop checking by hand.

---

## D8 — LED patterns, judged by eye

**Polish item**, not a §9 row. **Covered by:** `stylus/tests/test_led.py` proves the pattern
_timings_; nothing can prove they're legible.

Sit where you'd actually sit. Walk the stand through all four states — idle (nothing on it), reading
(sleeve going down), playing (sleeve settled), error (D5's fast blink) — and answer one question per
state: **could you tell what the stand is doing without looking at a terminal?**

Tune in `stylus/config.toml`, restart, look again. The patterns are semantic
(`stylus/led.py`), so a change is a pattern edit, not a rewrite.

**Fails if:** any two states read the same from across the room. Note that idle-breathe degrades to a
slow blink on a non-PWM pin — if that's what you're seeing, it's cosmetic and expected.

---

## D9 — Debounce + tag-removal timing, on the real mount

**Polish item.** This is the one the issue calls out explicitly and the last thing left open from
#52 (stylus-spec §11 milestone 6). **Covered by:** `stylus/tests/test_state_machine.py` proves the
debounce _counting_; only the stand can tell you the counts are right.

Defaults (`stylus/config.toml`, `[reader]`):

| Knob                       | Default | Tunes                                    |
| -------------------------- | ------- | ---------------------------------------- |
| `insertion_debounce_polls` | 2       | how settled a sleeve must be to fire     |
| `removal_debounce_polls`   | 10      | how long a lift must last to fire `stop` |
| `swap_debounce_polls`      | 1       | how fast a sleeve swap crossfades        |

Three passes, ~10 reps each:

1. **Place** — sleeve down at a normal speed. Fires `start` every time? Any misses mean the antenna
   position or `insertion_debounce_polls` is wrong. Any _double_ fires mean it's too low.
2. **Lift** — sleeve off. Fires `stop` promptly, but a momentary wobble mid-play does **not**. Those
   two pull `removal_debounce_polls` in opposite directions; find the seam.
3. **Swap** — sleeve A off, sleeve B straight on. Should feel like a crossfade, not stop-then-start.

```sh
curl -s http://$PIZERO:4741/status   # `observed` = what the reader sees right now; `state` = what fired
```

`observed` vs `state` is the whole diagnostic: a tag in `observed` that never becomes a `state`
change is a debounce problem; nothing in `observed` at all is a mount/antenna problem.

**Record your final values** — they're the deliverable of this drill, and they belong in
`config.example.toml` if they differ much from the defaults.

---

## D10 — Loop-seam blend, judged on the TV

**Polish item**, deferred here by name:
[ADR 0011](adrs/0011-auto-generate-visualizer-clips.md) says the single loop-seam blend "is best
tuned against real playback on the stand (step 12 / issue #53)."

Today a spliced visualizer can crossfade the seams **between clips** (the "Crossfade the seams
(0.5s)" checkbox / `crossfadeSec` on `POST …/video/splice`). What is **not** built is a head/tail
wrap at the loop point itself — end→start is still a hard cut every time the clip repeats.

Play a spliced album for **three full loops** on the TV, from where you'd sit. The only question:
**is the loop point visible?**

**Observable:** either the wrap cut is invisible in motion (the inter-clip crossfade was carrying it,
and ADR 0011's refinement stays unbuilt), or it reads as a jump — in which case file the head/tail
wrap as its own issue with a note about which album made it obvious. Longer clips and slower motion
hide it; short, high-motion clips are the honest test, so pick one of those.

This drill's output is a decision, not a pass/fail. Record which way it went either way — an
unrecorded "looked fine to me" is how ADR 0011's open question stays open for another year.

---

## Results

| Drill                        | Run on | Result | Notes / issue filed |
| ---------------------------- | ------ | ------ | ------------------- |
| D1 idle timeout restores     |        | ☐      |                     |
| D2 bridge unreachable        |        | ☐      |                     |
| D3 video file missing        |        | ☐      |                     |
| D4 album not in library      |        | ☐      |                     |
| D5 downstream unreachable    |        | ☐      |                     |
| D6 bad JSON asset            |        | ☐      |                     |
| D7 sync verification         |        | ☐      |                     |
| D8 LED legibility            |        | ☐      |                     |
| D9 debounce / removal timing |        | ☐      |                     |
| D10 loop-seam blend          |        | ☐      |                     |

When every row is filled in, #53 is done. Anything that failed is its own issue on the
[bug-fix workflow](specs/bug-fix-workflow.md) — the drill found it, which is the point.
