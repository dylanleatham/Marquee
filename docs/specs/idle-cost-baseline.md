# Idle cost baseline

_What Marquee costs when nothing is happening, measured rather than felt. Marquee is an always-on
system — Curator, Conductor, Backdrop and Amp sit at zero traffic for hours — so idle cost is a
product requirement. This doc is the number a regression gets noticed against. Decision on how it is
enforced: [ADR 0049](../adrs/0049-idle-cost-is-a-measured-baseline-not-a-ci-gate.md). Measured for
[#137](https://github.com/dylanleatham/Marquee/issues/137)._

## 1. The headline

**At idle, no Marquee configuration costs more than 1.2% of one CPU core.** On the eight-core
workstation this was measured on, the worst case — the packaged desktop app with its window open —
is **0.14% of the machine**. Minimize that window and it falls to **0.04%**.

The heat that prompted this audit is not Marquee sitting idle. Whatever is warming the machine, it
is something else; measuring first is what makes that sentence sayable.

## 2. The leading hypothesis was wrong

[#137](https://github.com/dylanleatham/Marquee/issues/137) opened on a reasonable guess: that dev
tooling — vite, turbo watchers, `tsx watch` across four packages — accounted for most of the heat,
and that optimizing app code first risked chasing the wrong thing. Measuring it first was the right
call, and it came back the other way.

`pnpm dev`, with all four watchers running, costs **0.88% of one core**. The packaged desktop app,
with no watchers at all, costs **1.14%**. Dev mode is the _cheaper_ of the two on CPU.

Dev mode is not free, but the price is **memory, not CPU**: 35 processes holding **1345 MB**
resident, against the packaged app's 6 processes and 509 MB. If `pnpm dev` makes a machine
uncomfortable, RAM pressure is the mechanism to look at, not CPU.

## 3. Measured numbers

Method, machine and caveats in §6. Percentages are of **one core**; the machine column divides by
the 8 logical processors. Every figure is a 2–3 minute window at zero traffic after a settle period.

| Configuration                   | Procs | CPU-s | % of 1 core | % of machine |     RSS |
| ------------------------------- | ----: | ----: | ----------: | -----------: | ------: |
| Control (nothing of ours up)    |     0 |  0.00 |       0.00% |       0.000% |    0 MB |
| `pnpm dev` (4 watchers)         |    35 |  1.59 |       0.88% |       0.110% | 1345 MB |
| Packaged desktop app, visible   |     6 |  2.06 |   **1.14%** |       0.142% |  509 MB |
| Packaged desktop app, minimized |     6 |  0.62 |       0.34% |       0.043% |  506 MB |

Each service alone, run from built `dist/` with no watcher — the shape they run in on a Pi:

| Service         | CPU-s over 120s | % of 1 core |   RSS |
| --------------- | --------------: | ----------: | ----: |
| `curator`       |            0.25 |       0.21% | 67 MB |
| `backdrop`      |            0.03 |       0.03% | 50 MB |
| `hue-conductor` |            0.02 |       0.02% | 51 MB |
| `amp`           |            0.00 |       0.00% | 52 MB |

All four together are about **0.25% of one core** and **220 MB**. Curator is the most expensive by
an order of magnitude, which is expected — it is the only one with a UI, a poll loop and Roadie's
queue. The three that actually live on Pis are essentially free.

> The per-service rows exclude the `conhost.exe` each one gets for being launched from a Windows
> console (up to 0.09 CPU-s, more than the service itself in Conductor's case). On a Pi under
> systemd there is no console host, so counting it would overstate the on-device cost.

## 4. `backgroundThrottling`: the default is right, and here is the number

The desktop shell leaves Electron's `backgroundThrottling` at its default (`true`), and should.
Minimizing the window takes the app from **1.14% → 0.34% of a core**, a 70% cut, and the split shows
exactly where it comes from:

| Process               | Visible | Minimized |
| --------------------- | ------: | --------: |
| `Marquee renderer`    |   0.42s | **0.00s** |
| `Marquee utility`     |   0.31s | **0.00s** |
| `Marquee gpu-process` |   0.02s | **0.00s** |
| Curator (forked)      |   0.56s |     0.27s |
| Conductor (forked)    |   0.22s |     0.17s |
| Electron main         |   0.53s |     0.19s |

The renderer stops **dead** — not "reduces", 0.00 CPU-seconds over three minutes. That is Chromium
throttling timers and suspending rAF in a hidden window, which is precisely the behaviour that
default buys.

The issue framed this window as "kiosk-style", and that framing is what makes `backgroundThrottling:
false` look tempting. It isn't a kiosk: it loads **Curator**, a workbench you leave open and walk
away from. The kiosk is **Backdrop**, which is Chromium on a Pi and a different codebase entirely,
governed by [ADR 0040](../adrs/0040-visualizers-carry-a-decode-budget.md)'s decode budget. Setting
`backgroundThrottling: false` here would read as "keep the UI responsive" and mean "keep burning CPU
behind a minimized window" — it would throw away the single largest idle saving in the table.
`packages/desktop/test/idle-power.test.ts` fails if it is ever added.

## 5. `powerSaveBlocker`: none, and none wanted

No service holds a `powerSaveBlocker` or otherwise inhibits sleep. The only sleep suppression
anywhere in the repo is Backdrop's `packages/backdrop/deploy/kiosk.sh` (`xset s off`, `xset -dpms`,
`xset s noblank`), which is deliberate, scoped to that Pi's X session, and required — a wall display
that blanks after ten minutes reads as a crash (backdrop-spec §11). The workstation must stay free to
sleep; the same test guards this.

## 6. Baseline thresholds

Thresholds sit at roughly **2× measured**, so ordinary run-to-run variance does not trip them but a
real regression — a rAF loop without a visibility gate, a poll that forgot its `visibilitychange`
handler — does. A breach is a question to investigate, not an automatic failure.

| What                                | Measured |             **Budget** |
| ----------------------------------- | -------: | ---------------------: |
| Any single service, idle, on-device |    0.21% | **< 0.5%** of one core |
| All four services together          |    0.25% | **< 1.0%** of one core |
| Packaged desktop app, visible       |    1.14% | **< 2.5%** of one core |
| Packaged desktop app, minimized     |    0.34% | **< 1.0%** of one core |
| `pnpm dev`, all watchers            |    0.88% | **< 2.0%** of one core |
| `pnpm dev`, resident memory         |  1345 MB |          **< 2000 MB** |

## 7. How to re-measure

`scripts/idle-audit.mjs` takes two `Win32_Process` snapshots N seconds apart. The kernel+user CPU
counters are monotonic 100-ns values, so the delta is exactly the CPU burned in the window — no
sampling error, and no dependence on perf-counter names (which are localized) or on Task Manager's
"power usage" column (which is a qualitative bucket, not a number). Run it from **PowerShell**, not
Git Bash, which mangles the path variables the services read.

```bash
node scripts/idle-audit.mjs --label curator-alone --duration 120 --settle 25 --match curator --out perf-samples
```

`--root <pid>` measures a whole process tree; `--match <regex>` matches command lines; with neither,
the run is a machine-only control. Every run also reports the machine-wide busy figure, because a
per-process number means nothing without knowing what the box was doing under it. Raw samples land in
`perf-samples/` (gitignored).

**Windows exposes no scriptable per-process wattage.** Task Manager's power column is a bucket,
`powercfg /energy` is whole-machine, and SRUM's per-app energy estimates are hourly and need admin.
CPU-seconds is the proxy used here, on the grounds that it is what actually drives the heat and it is
the only figure repeatable enough to compare across runs.

### Caveats on the numbers above

- **8 logical processors, Windows 11.** Percentages of "the machine" do not transfer to a 4-core Pi;
  the "% of one core" column is the portable one.
- **The box was not silent.** A ~10% machine-wide busy floor persisted (Claude Desktop, which was
  running the audit, plus a Teams tray process). Per-process attribution is robust to this, but
  heavy contention would inflate the figures slightly rather than deflate them — the numbers are, if
  anything, pessimistic.
- **Two instrument bugs were found by running it**, both now covered by tests in
  `contract-tests/idle-audit.test.mjs`. Windows' System Idle Process (pid 0) accumulates every
  _unused_ cycle, so summing it reported the machine at 101% busy. And `ParentProcessId` is never
  cleared, so a five-day-old orphan whose dead parent's pid had been recycled into Marquee's renderer
  was charged to the desktop app — worth 0.2% of a core, about 18% of that configuration's real
  total. A child may not predate its parent; the walk now checks.
- **Reproducibility is ±0.1% of a core at best** at these magnitudes. Do not read a 0.05% change as
  signal.
