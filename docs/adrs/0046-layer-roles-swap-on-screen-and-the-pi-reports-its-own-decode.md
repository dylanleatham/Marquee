# ADR 0046 — The kiosk's layer roles swap on screen, and the Pi reports its own decode

Status: accepted · Date: 2026-08-02 · Amends: backdrop-spec §7/§8/§10/§13,
`packages/backdrop/DEPLOY.md` §14 · Builds on:
[ADR 0040](0040-visualizers-carry-a-decode-budget.md) (decode budget enforced on ingest) ·
Closes [#211](https://github.com/dylanleatham/Marquee/issues/211)

## Context

Playback on the Pi was still glitchy after ADR 0040 landed, and in the sleeve-swap case it was
_worse_ than before. ADR 0040 read every glitch as a decode-throughput problem and fixed the
throughput. It was right that the files were far over budget. It was wrong that throughput was the
only thing wrong, and it had no way to know — which is the second half of this ADR.

**The kiosk's two video layers swapped roles on a timer, not on screen.** `app.js` keeps `<video-a>`
and `<video-b>`; one is on screen and the other is free to load into. The role swap sat inside the
same `setTimeout(…, 450)` that tore down the outgoing element, so for the entire length of a
crossfade the "free" variable pointed at the video the viewer was watching. `onReady` closed over
those live bindings too, so a callback that fired after a swap operated on the wrong pair entirely.

Every command the hardware actually sends lands inside that window:

| What happens on the stand                | What the SPA did                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swap sleeves during a crossfade          | Loaded the new clip over the element on screen (hard cut, no crossfade), then its second swap timer ran `removeAttribute("src") + load()` on the video that was playing. **Black screen**, roles left crossed — so every later play repeated it.                                                                     |
| Re-scan the album already starting       | The duplicate guard read `active`, whose `is-visible` is dropped the instant the incoming clip appears — so the guard missed and re-assigned `src`, **restarting the clip from frame zero**.                                                                                                                         |
| Lift a sleeve before the clip has loaded | `stop` never detached the pending `canplay`. The video went on screen and hid the idle overlay anyway; the stop's own 650 ms cleanup then paused it. **A frozen frame with no idle gradient**, until the next scan.                                                                                                  |
| Any sleeve swap                          | Stylus publishes `stop` then `start` for a SWAP and documents "No IDLE in between" (stylus-spec §7). The SPA revealed the idle overlay on the `stop` and only hid it at the new clip's `canplay` — hundreds of ms later here — so **every swap flashed the idle gradient**. backdrop-spec §2 rules that out by name. |

The kiosk SPA's first tests arrived with ADR 0040 and cover only commands that arrive cleanly
separated: one command, its `canplay`, the fade, then the next. That is not traffic the hardware
produces. Nothing exercised overlapping commands, which is the only kind it produces.

**And nothing measured playback.** ADR 0040 observed that Curator's preview cannot catch a
decode-budget defect — a workstation has a hardware decoder and doesn't care — and made the ingest
budget the substitute for that missing signal. But a budget is a guess until something measures the
result, and nothing did: the only report of a glitch was a person watching the display. That is the
same gap that let that ADR's GPU flags ship on reasoning alone and boot the kiosk to a black screen.

## Decision

**1. The roles swap the moment a clip is put on screen, in one synchronous step.**

`show(el)` makes the incoming layer visible, hides and pauses the outgoing one, reassigns
`showing`/`spare`, and _then_ schedules the outgoing element's teardown against a **captured**
reference. The timer's only remaining job is releasing a decoder. There is no longer any window in
which `spare` is the element being watched, so a command arriving mid-crossfade is structurally
incapable of loading over the picture. That single change fixes the first row of the table above and
makes the rest expressible.

**2. A loading clip is an explicit `pending` record, not a pair of anonymous listeners.**
`abandonPending()` detaches both `canplay` and `error`, and both `play` and `stop` call it. A
superseded load can no longer surface later, and the `error` listeners no longer accumulate on the
elements for the life of the process.

**3. The duplicate guard reads `currentPath` alone**, not a class off a layer. It cannot be fooled by
a fade in progress. `onError` releases `currentPath` so a retry of a failed album isn't swallowed by
it.

**4. Cancelling a stop restores what the stop was fading out.** In practice a cancellable stop _is_
the first half of a sleeve swap, so putting the outgoing clip back on screen turns a swap into the
crossfade the spec asks for. Once the cleanup has actually run there is nothing to put back and the
gradient rightly stays — a genuine stop is unaffected.

**5. An idle kiosk holds no video resource at all.** The stop cleanup now releases both layers, not
just the outgoing one. Consistent with ADR 0040's theme: don't hold a decoder for something nobody
can see.

**6. The Pi reports how it actually decoded.** `HTMLVideoElement.getVideoPlaybackQuality()` gives
frames decoded and frames dropped; on a board that decodes H.264 in software, dropped frames _are_
the stutter. The kiosk samples the on-screen layer every 10 s and sends a `playback-quality` browser
event; `QualityMonitor` turns the counters into a verdict and `/api/status` serves it as
`playbackQuality`. Sustained loss over **2%** is `degraded` — roughly one visible hitch per second at
30 fps — and logs a warning **once per clip**, not once per sample.

~~The threshold ignores samples under 30 frames: a couple of frames lost around a `loop` restart is
normal, and a percentage off a handful of frames swings wildly and means nothing.~~ Counters arriving
from the browser are clamped, because a WebSocket frame is unvalidated input and `NaN` would
serialise as `null` — reading as "no signal" rather than "a bad frame arrived".

> **Amended 2026-08-02 by [ADR 0048](0048-the-playback-verdict-describes-the-last-interval.md)
> (issue #216):** the verdict is computed from the **interval** between samples, not from the
> cumulative counters. Judged against a lifetime total it lagged reality by minutes — the first
> deploy to use it kept reporting `degraded` for five samples after a panel-resolution change stopped
> the drops dead. The 30-frame floor moves with it, to 150 frames measured over the window. Sustained
> 2% and once-per-clip both stand; recovery now needs to clear 1% to re-arm that warning.

**7. Nothing in the decode budget changed.** It is tempting to drop the ceiling again — measured
here, decode cost tracks bitrate far more than resolution (1080p at 8 Mbps costs ~2.2x the CPU of
720p at 3.5 Mbps, but only ~1.25x the same 720p held at 8 Mbps). But ADR 0040 already pulled that
lever from ~20 to 7.3 Mbps, and whether the board still lacks headroom at 7.3 is exactly what
decision 6 now answers. Changing the budget again first would repeat that ADR's own recorded
mistake. **The number comes first.**

## Consequences

- **A sleeve swap crossfades.** Previously it either flashed the idle gradient or cut to black,
  depending on where in the fade it landed. This is the visible fix.
- **Overlapping commands are now the tested case.** Eight tests drive the SPA through mid-crossfade
  plays, bursts, repeat scans, stop-during-load, and swap timing. The pre-existing eight are
  unchanged and still pass, so the ADR 0040 behaviours they pin are intact.
- **`/api/status` grows `playbackQuality`.** `null` when idle, or when the kiosk hasn't yet sent a
  sample for the file on screen — a verdict from the previous album would be worse than none. The
  field is additive; nothing that reads `/api/status` today has to change.
- **A new `playback-quality` browser event.** Internal to Backdrop (the browser is the same box), so
  it lives in `packages/backdrop/src/types.ts` and not in `@marquee/contracts`, like the rest of that
  channel.
- **The kiosk sends one small WebSocket frame every 10 s while playing.** Nothing while idle. On a
  loopback socket this is free; the interval exists so the journal warning has a trend behind it
  rather than a single reading.
- **This does not, by itself, prove the stutter is gone.** It fixes every glitch that is in the
  code and gives the board a voice for the rest. If `droppedPct` is still over the threshold on real
  visualizers, the next move is a lower budget ceiling — and it will be a measurement, which is the
  whole point.
- **The CSS half remains untested.** As with ADR 0040, whether a paint actually stops needs a real
  browser; `app.js` is driven by shadowing `document`/`location`/`WebSocket`, which covers ordering
  and state but not rendering. The Playwright gap in
  [testing-strategy](../specs/testing-strategy.md) is still owed.
