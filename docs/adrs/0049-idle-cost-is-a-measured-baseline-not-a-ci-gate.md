# ADR 0049 — Idle cost is a measured baseline and a reviewer rule, not a CI gate

Status: accepted · Date: 2026-08-02 · Establishes:
[idle-cost-baseline.md](../specs/idle-cost-baseline.md), runtime-overview §8 ("Idle cost") · Relates
to: [ADR 0040](0040-visualizers-carry-a-decode-budget.md) (the same "measure it, don't reason about
it" move, on the Pi's decode budget) · Closes
[#137](https://github.com/dylanleatham/Marquee/issues/137)

## Context

Marquee is always-on. Curator, Conductor, Backdrop and Amp are expected to sit at zero traffic for
long stretches, so what the system costs while doing nothing is a product requirement rather than a
detail. The prompt for [#137](https://github.com/dylanleatham/Marquee/issues/137) was that devices
ran hot with the apps idle — and there was no measured baseline, so "hot" could not be checked
against anything.

The issue named a leading hypothesis and, to its credit, insisted it be tested before any code was
touched: that `pnpm dev`'s watchers — turbo, four `tsx watch` processes, esbuild — accounted for most
of the cost. It also asked for a decision on whether idle cost should get a CI regression check or a
periodic manual pass.

Measuring settled it, and inverted it. `pnpm dev` idles at **0.88% of one core**; the packaged
desktop app, with no watchers at all, idles at **1.14%**. Dev tooling is the cheaper configuration.
Nothing measured exceeds **1.2% of one core**, or 0.15% of the eight-core machine. Dev mode's real
cost is memory — 1345 MB across 35 processes against the packaged app's 509 MB across 6.

So the audit's actual finding is that **Marquee at idle is not what is warming the machine**, and the
question becomes how to keep it that way.

Two bugs of the relevant class had already been found and fixed before this ran, both by reading code
rather than by profiling: a rAF loop per effect card driving a 25 fps animation at 60
([#135](https://github.com/dylanleatham/Marquee/issues/135)), and palette previews still ticking
behind a hidden tab ([#136](https://github.com/dylanleatham/Marquee/issues/136)). That is the shape a
future regression will take.

## Decision

**1. The baseline is a written number with budgets at ~2× measured.**
[idle-cost-baseline.md](../specs/idle-cost-baseline.md) records what each configuration costs and the
budget it must stay under. Budgets sit at roughly twice the measured figure: tight enough that a
stray animation loop breaches them, loose enough not to flap on run-to-run variance. A breach opens
an investigation; it does not by itself fail anything.

**2. No CI regression check.** Four reasons, in descending order of how much they settle it:

- **The signal is far below CI's noise.** The interesting deltas are tenths of a percent of one core.
  Shared, virtualized runners have unpredictable neighbours; this workstation could not get below a
  ~10% machine-wide floor even after quiescing. A check that cannot distinguish a regression from a
  noisy neighbour will be muted within a month, and a muted check is worse than none because it
  reads as coverage.
- **It costs minutes of runner time per configuration.** The measurement is inherently
  wall-clock-bound — settle, then hold still for two to three minutes. There is no way to make it
  fast, because holding still _is_ the measurement.
- **The harness is Windows-only.** It reads `Win32_Process`; the Linux legs would need a second
  implementation, doubling the surface for a signal that is already untrustworthy there.
- **This class of bug has never been caught by measurement anyway.** #135 and #136 were both found by
  reading code. The audit that followed them found no further instances.

**3. The durable gates are static, cheap and specific instead:**

- **A reviewer rule.** The Runtime Reviewer now blocks — at `info` — on a repeating timer or
  animation loop with no visibility gate: `requestAnimationFrame`, `setInterval`, or a
  `setTimeout` chain that keeps running when the tab is hidden or the element is off screen. It names
  `usePoll` as the pattern to copy. This targets the #135/#136 class directly, on every review, for
  free.
- **Two assertions on the desktop shell.** `packages/desktop/test/idle-power.test.ts` fails if
  `backgroundThrottling` is ever set (the default `true` is worth 70% of the app's idle cost — see
  decision 4) or if a `powerSaveBlocker` appears. Both are one-line changes that look harmless in a
  diff and are only visible hours later as a warm laptop.
- **Tests on the instrument itself.** `contract-tests/idle-audit.test.mjs` covers the sampler's
  arithmetic, because a harness that quietly reports 0% is indistinguishable from a system that is
  genuinely quiet — the exact failure the baseline exists to prevent.

**4. A periodic manual pass, run on suspicion rather than on a schedule.** `scripts/idle-audit.mjs`
is checked in and documented so re-measuring is one command. Run it when someone reports heat, before
a release that touched the UI's timers, or after adding a service. Not on a calendar: a recurring
task nobody has a reason to run gets skipped, and the baseline's value is that it is _available_ when
there is a question, not that it is re-collected monthly.

## Consequences

- **"The machine is hot" is now a checkable claim.** It was not before. The likely answer for the
  next report is "not us", and that is worth being able to say with a number in under five minutes.
- **A regression in idle cost will be caught at review or not at all.** This is accepted
  deliberately. The reviewer rule covers the class that has actually occurred twice; anything outside
  it — a service that starts polling a bridge every second, say — reaches a human. The mitigation is
  that the manual pass is cheap enough to run on suspicion.
- **The baseline will go stale**, and that is tolerable in a way a stale _gate_ would not be. A
  number dated 2026-08-02 on a named machine is honest about what it is. Re-measure and add a row
  rather than silently editing the old one.
- **The numbers are workstation numbers.** Nothing here was measured on a Pi. The "% of one core"
  column is the portable one; the "% of machine" column is not, and Backdrop's real constraint on a
  Pi is decode headroom under load ([ADR 0040](0040-visualizers-carry-a-decode-budget.md),
  [ADR 0047](0047-the-kiosk-display-pipeline-not-the-decoder.md)), which is a different question from
  idle cost and already has its own instrumentation.
- **Two instrument bugs were found by running the instrument**, and both were the same species as the
  ones it hunts: silent, plausible, wrong. Windows' System Idle Process made the machine read 101%
  busy; a recycled pid let a five-day-old `figma_agent.exe` be charged to Marquee's renderer, worth
  18% of that configuration's total. Both are now tested. The lesson taken forward is that a
  measurement tool needs its own tests before its output is quoted — which is why decision 3 lists
  them as a gate rather than as housekeeping.
