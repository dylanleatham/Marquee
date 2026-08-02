# ADR 0047 — The glitches were the display pipeline, not the decoder

Status: accepted · Date: 2026-08-02 · Amends: backdrop-spec §4/§13,
`packages/backdrop/DEPLOY.md` §11b/§11d/§14/§15 · Builds on:
[ADR 0040](0040-visualizers-carry-a-decode-budget.md) (decode budget on ingest),
[ADR 0046](0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md) (the Pi reports its
own decode) · Closes [#211](https://github.com/dylanleatham/Marquee/issues/211)

## Context

ADR 0046 shipped a dropped-frame signal precisely so the next decision here would be a measurement.
It answered on its first run, and the answer was that **two ADRs' worth of work had been aimed at the
wrong subsystem.**

Deployed to the real stand, with every visualizer already inside ADR 0040's decode budget (H.264,
1920x1080@30, ~7.4 Mbps, no audio track), `/api/status.playbackQuality` reported:

```
total=606  dropped=39   6.4%   degraded=true
```

and held ~5.5% between successive samples — roughly 1.7 frames lost every second. But the board was
plainly not the constraint:

| Check                    | Reading            |
| ------------------------ | ------------------ |
| `vcgencmd get_throttled` | `0x0`              |
| SoC temperature          | 56.5 °C            |
| Chromium CPU             | ~45% of four cores |
| Load average             | 1.09               |

A decode bottleneck saturates cores. This one had headroom to spare. `xrandr` had the answer:

```
HDMI-2 connected 3840x2160+0+0
   3840x2160     30.00*+
```

**The panel was running 4K at 30 Hz**, and that is two separate defects wearing one mode line:

1. **4K.** Chromium renders the entire page at 3840x2160 and rescales every decoded 1080p frame.
   backdrop-spec §4 already warned this "costs more than the decode" — as a caution to check, never
   as something anyone had measured.
2. **30 Hz.** A 30 fps clip on a 30 Hz panel gets exactly one scanout slot per frame. There is no
   slack: a frame even slightly late is simply gone. At 60 Hz a late frame just repeats the previous
   one and nothing is lost. This half was in no document at all, and it is the larger of the two.

Forcing `1920x1080@60` on the same file, same board, same build took the sustained rate from **5.5%
to 0%** — 3 dropped frames at clip start, then zero across 600 consecutive frames, and zero again
across a sleeve swap.

That exposed a second defect the stutter had been masking. With playback smooth, a **stationary
horizontal line about a third of the way down** was visible on every video. It is screen tearing, but
it does not look like tearing: Raspberry Pi OS autostarts `xcompmgr`, which does no vsync, so
Chromium page-flips mid-scanout — and because a 30 fps clip on a 60 Hz panel holds a fixed phase
relationship, the tear parks at a constant height instead of drifting. Stopping the compositor while
a clip played removed it immediately.

Critically, **tearing is invisible to the ADR 0046 signal**: `getVideoPlaybackQuality()` reports 0%
dropped while the panel tears, because no frame was ever late. The new measurement is a decode
instrument, not a display instrument, and this ADR is where that limit gets written down.

## Decision

**1. The kiosk forces `1920x1080@60` itself, on every launch.** `xrandr` at runtime does not survive
a reboot, so it belongs in the launcher. The connected output is detected rather than hardcoded —
which port is live differs per install (this board reports `HDMI-2`), and a wrong `--output` name
fails silently, leaving the panel at 4K with nothing to say so.

**2. The compositor is disabled for the kiosk user**, via `~/.config/autostart/xcompmgr.desktop`
shadowing the system entry by filename. A user-level override rather than an edit to
`/etc/xdg/autostart/`, so an apt upgrade cannot quietly undo it. Nothing on this box needs
compositing: the display only ever shows one fullscreen window, and without a compositor that window
scans out directly and the `modesetting` driver flips on vblank.

`Option "TearFree" "true"` on the modesetting driver is the other standard fix and is the one to
reach for if a future image needs a compositor. It was not chosen because this driver build exposes
no `TearFree` xrandr property, so it could not be tested without editing `xorg.conf.d` and restarting
X — whereas dropping the compositor was verifiable live, on a playing clip, and reversible in one
command. Given ADR 0040's GPU flags, "testable in isolation and instantly revertible" is worth more
here than "canonical".

**3. Both are checked into the repo and installed by copying, not pasting.**
`packages/backdrop/deploy/kiosk.sh` and `packages/backdrop/deploy/xcompmgr.desktop` are the source of
truth; DEPLOY.md points at them. The launcher previously existed **only** as a blob pasted out of the
runbook, which meant the Pi and the repo could disagree with nothing able to notice — and for the
entire life of #211 they did.

**4. `test/deploy-assets.test.ts` guards all of it.** These are shell and desktop files that nothing
imports, and every defect they encode is an _invisible_ one: a missing mode line drops 5.5% of frames,
a re-added GPU flag boots to a black screen, a second copy in DEPLOY.md rots. None of that surfaces in
a build, a type-check, or any runtime assertion — the display just looks wrong across the room. The
test asserts the mode is set, the output is detected rather than hardcoded, the three banned GPU flags
never reappear, the override actually suppresses autostart and says how to undo itself, and DEPLOY.md
references the files instead of duplicating them.

**5. The decode budget stays exactly where ADR 0040 left it.** ADR 0046 declined to lower it until
there was a number. The number arrived and said the ceiling was never the problem. Re-encoding the
library to 720p would have cost an evening and changed nothing.

## Consequences

- **Playback is clean on the real hardware**: 0% dropped sustained, no tear line, and a sleeve swap
  crossfades. That is the first time any of this has been true and _measured_ rather than eyeballed.
- **Two settings now matter more than the entire encode pipeline**, and both live outside the
  application. Anyone reflashing a card who skips step 11d gets the old behaviour back at full
  strength, which is why the guard is a test and not a paragraph.
- **`playbackQuality` is a decode instrument only.** It cannot see tearing, and it will read a
  perfect 0% on a torn picture. DEPLOY.md's troubleshooting table now carries two distinct rows for
  what a person would describe identically as "the video looks bad", with the discriminator being
  whether frames go _missing_ or a frame is _split_.
- **A `git pull` does not update the installed copies.** They are copies by design — the alternative
  is symlinking into the repo, which makes the kiosk's boot depend on a clean working tree. DEPLOY.md
  §15 carries the two `diff` commands that answer "am I current?" instead.
- **ADR 0040's §4 warning was right and unheeded for a month** because it was phrased as a thing to
  check, in a bill-of-materials section, with no number attached. The general lesson is not "measure
  more" but where to put a measurement: a caution buried in prose loses to a mode line the panel sets
  itself on every boot. It is enforced now.
- **The remaining unknown is unchanged**: whether Chromium on Pi OS will use the Pi 5's HEVC hardware
  decoder for a `file://` `<video>` (ADR 0040). With the display pipeline fixed there is now decode
  headroom to spare, so the incentive to run that experiment is much weaker than it looked yesterday.
