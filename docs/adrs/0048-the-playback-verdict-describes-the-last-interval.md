# ADR 0048 — The playback verdict describes the last interval, not the life of the clip

Status: accepted · Date: 2026-08-02 · Amends:
[ADR 0046](0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md) (decision 6),
backdrop-spec §8/§10, `packages/backdrop/DEPLOY.md` §14 · Builds on:
[ADR 0047](0047-the-kiosk-display-pipeline-not-the-decoder.md) (the panel mode this signal was being
read to confirm) · Closes [#216](https://github.com/dylanleatham/Marquee/issues/216)

## Context

[ADR 0046](0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md) gave the board a
voice: the kiosk samples `getVideoPlaybackQuality()` every 10 s, `QualityMonitor` turns the counters
into a verdict, `/api/status` serves it. The point of that ADR was to stop deciding decode questions
by reasoning and start deciding them by measurement.

Then the measurement was used for the first time, during the #211 deploy, and it lied.

That deploy is [ADR 0047](0047-the-kiosk-display-pipeline-not-the-decoder.md)'s story from the other
side. The Pi's panel was running at 3840x2160@30, so Chromium was rescaling every frame and losing
~5.5% of them — correctly reported, and the reason the display looked bad. Forcing the panel to
1920x1080@60 stopped the drops **dead**: from that moment the decoder lost nothing at all. That ADR
had to read _"held ~5.5% between successive samples"_ — a delta, computed by hand off consecutive
readings — to reach its conclusion, because the field it was reading would not say so itself.
`/api/status` went on
reporting `degraded: true` for five more samples — 4.5%, 4.1%, 3.8%, 3.5%, 3.3% — because
`getVideoPlaybackQuality()` returns **cumulative** counters for the video element, and the 285 frames
already lost stayed in the numerator while fresh good frames slowly diluted them.

So the verdict lagged reality by minutes, and did it in the one situation the field exists for:
someone has just changed something and wants to know whether it helped. A number that takes minutes
to agree that a fix worked reads, in the moment, as the fix not working — which is worse than no
number, because it is confidently wrong. ADR 0046 anticipated the follow-on decision ("if
`droppedPct` is still over the threshold, the next move is a lower budget ceiling") without noticing
that its own signal could not tell that decision apart from a stale average.

## Decision

**1. `droppedPct` and `degraded` describe the interval since the previous sample.**
`QualityMonitor.record()` keeps the last sample for the clip and subtracts: frames decoded and frames
dropped **since**, not since the file loaded. A rate is a thing per unit time, and the counters are
totals; the difference between two totals is the only place a rate was ever going to come from.

**2. The cumulative pair stays in the report,** as `totalFrames` / `droppedFrames`, joined by the
window they were measured over (`intervalFrames` / `intervalDropped`). "Nothing dropped in the last
ten seconds, 285 lost over the clip" is a more useful sentence to an operator than either half, and
publishing the window is what makes a `droppedPct` of 0 next to a large `droppedFrames` read as
intended rather than as a bug.

**3. A counter that goes backwards is a fresh clip, not a negative rate.** The counters belong to the
video _element_ and reset when it gets a new source — the next album, a stop and a restart, or the
same file handed to the other layer, all of which the kiosk does routinely (ADR 0046 decision 1). The
baseline only survives while **both** counters are still climbing on the same `filePath`; otherwise
the sample is its own window, which is exactly what the browser has just started measuring. Dropped
frames cannot decrease within a clip, so a smaller one is a reset even when the total happens to land
above the old one — hence both counters, not just the total.

**4. The short-sample guard is expressed against the window, not the lifetime.** `MIN_FRAMES = 30`
made sense against a lifetime total, where it only ever suppressed the first second of a clip. Against
a delta it is nearly inert: a 10 s window holds ~300 frames at 30 fps, so 30 would judge partial
windows where 2% is well under one frame. It becomes `MIN_INTERVAL_FRAMES = 150` — half a sample
interval at 30 fps. A shorter window is still reported, just not judged, and the next full one judges
it: a real problem is delayed by one sample, never hidden.

**5. Recovery needs hysteresis.** Per-interval rates are far twitchier than the lifetime average they
replace, and a board sitting near 2% will cross it in both directions all evening. The
warned-once-per-clip rule (ADR 0046 decision 6) would then re-arm on every dip and spend the warning
on the next sample. So the warning re-arms only below **half** the threshold — a dip under the line
isn't recovery, a clear reading is.

## Consequences

- **The number now answers the question it is asked.** Change something on the Pi, wait one sample
  interval, read the verdict. That is what `DEPLOY.md` §14's "ask the Pi first — don't guess" row
  promises, and it is now true.
- **`/api/status.playbackQuality` grows two fields** (`intervalFrames`, `intervalDropped`) and keeps
  every field it had. Additive, so nothing that reads it has to change — but `droppedPct` now means
  something different from what it meant yesterday, which is why this is an ADR and not a patch.
- **A transient hiccup is now visible and then gone.** Under cumulative counters a bad first minute
  tainted the clip's number forever; under deltas it shows up in one sample and clears. This is the
  intended behaviour, and it does mean the field cannot answer "was this clip _ever_ bad" — the
  journal warning is what answers that, which is why it stays.
- **The suite could not have caught this, and now can.** Every existing test fed `record()` a
  _single_ sample, and for a single sample the lifetime ratio and the interval ratio are the same
  number — so the tests agreed with both implementations and discriminated between neither. Two of
  them fed repeated samples but held `totalFrames` constant, which no decoder does. The blind spot
  was a stream processor tested only as a function; the guard is a block of tests that drive a
  sequence of climbing counters, including resets, partial windows, and a wobble across the
  threshold.
- **The decode budget still hasn't moved,** for the reason ADR 0046 gave: the number comes first.
  What changed is that the number is now worth reading.
