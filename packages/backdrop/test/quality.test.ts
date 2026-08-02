// The playback-quality signal (issue #211). ADR 0040 shipped a decode budget with nothing measuring
// whether it worked; this is that measurement, so the rules for turning raw counters into a verdict
// are worth pinning.
//
// The blind spot that let #216 through: every test here fed `record()` a *single* sample, and for a
// single sample a lifetime ratio and an interval ratio are the same number — so the suite agreed
// with both implementations and discriminated between neither. The two tests that did sample
// repeatedly held `totalFrames` constant, which no decoder does. `record()` is a stream processor
// and was only ever tested as a function; the sequences below are the guard.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  QualityMonitor,
  DEGRADED_PCT,
  MIN_INTERVAL_FRAMES,
} from "../src/quality.js";

const at = () => "2026-08-02T12:00:00.000Z";
const sample = (
  over: Partial<Parameters<QualityMonitor["record"]>[0]> = {},
) => ({
  filePath: "/media/one.mp4",
  totalFrames: 1000,
  droppedFrames: 0,
  ...over,
});

describe("QualityMonitor", () => {
  it("reports the drop rate as a percentage of frames decoded", () => {
    const m = new QualityMonitor();
    const { report } = m.record(
      sample({ totalFrames: 1800, droppedFrames: 9 }),
      at,
    );
    expect(report.droppedPct).toBe(0.5);
    expect(report.degraded).toBe(false);
    expect(report.at).toBe(at());
  });

  it("calls a clip degraded once it is past the threshold", () => {
    const m = new QualityMonitor();
    const { report, newlyDegraded } = m.record(
      sample({ totalFrames: 1000, droppedFrames: 50 }),
      at,
    );
    expect(report.droppedPct).toBe(5);
    expect(report.droppedPct).toBeGreaterThan(DEGRADED_PCT);
    expect(report.degraded).toBe(true);
    expect(newlyDegraded).toBe(true);
  });

  it("only flags a clip as newly degraded once, so a steady problem logs one line", () => {
    // The kiosk samples every ten seconds. A visualizer that stutters for an evening would otherwise
    // fill the journal with the same warning several hundred times. Counters climb across the
    // samples the way a decoder's actually do — a clip that never decodes another frame is not a
    // steady problem, it's a stopped one.
    const m = new QualityMonitor();
    const steady = (totalFrames: number, droppedFrames: number) =>
      m.record(sample({ totalFrames, droppedFrames }), at).newlyDegraded;
    expect(steady(1000, 50)).toBe(true);
    expect(steady(2000, 90)).toBe(false);
    expect(steady(3000, 130)).toBe(false);
  });

  it("flags the next album separately", () => {
    const m = new QualityMonitor();
    m.record(sample({ droppedFrames: 50 }), at);
    const next = m.record(
      sample({ filePath: "/media/two.mp4", droppedFrames: 60 }),
      at,
    );
    expect(next.newlyDegraded).toBe(true);
  });

  it("re-arms when a clip recovers, so a later relapse is reported", () => {
    // Each step is an interval, not a lifetime total: 50 dropped out of the 1000 frames decoded
    // since the previous sample, then 0 out of the next 1000, then 50 again.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 1000, droppedFrames: 50 }), at); // 5% → degraded
    m.record(sample({ totalFrames: 2000, droppedFrames: 100 }), at); // 5% → still degraded
    m.record(sample({ totalFrames: 3000, droppedFrames: 100 }), at); // 0% → recovered
    expect(
      m.record(sample({ totalFrames: 4000, droppedFrames: 150 }), at)
        .newlyDegraded,
    ).toBe(true);
  });

  it("does not judge an interval too short to mean anything", () => {
    // One dropped frame out of ten is 10%, and says nothing — a `loop` restart alone can cost that.
    const m = new QualityMonitor();
    const { report, newlyDegraded } = m.record(
      sample({ totalFrames: 10, droppedFrames: 1 }),
      at,
    );
    expect(report.intervalFrames).toBeLessThan(MIN_INTERVAL_FRAMES);
    expect(report.droppedPct).toBe(10);
    expect(report.degraded).toBe(false);
    expect(newlyDegraded).toBe(false);
  });

  it("survives a browser that reports nothing decoded yet", () => {
    const m = new QualityMonitor();
    const { report } = m.record(
      sample({ totalFrames: 0, droppedFrames: 0 }),
      at,
    );
    expect(report.droppedPct).toBe(0);
    expect(report.degraded).toBe(false);
  });

  it("clamps counters that arrive nonsensical rather than reporting a nonsense rate", () => {
    // Nothing validates this frame on the way in — it is a message from a browser, and the SPA is
    // the one thing on this box we do not control the runtime of.
    const m = new QualityMonitor();
    const { report } = m.record(
      sample({ totalFrames: 100, droppedFrames: 400 }),
      at,
    );
    expect(report.droppedFrames).toBe(100);
    expect(report.droppedPct).toBe(100);

    const negative = m.record(
      sample({ totalFrames: -5, droppedFrames: -5 }),
      at,
    ).report;
    expect(negative.totalFrames).toBe(0);
    expect(negative.droppedFrames).toBe(0);
    expect(negative.droppedPct).toBe(0);
  });

  it("reads a missing counter as zero rather than NaN", () => {
    // A frame with fields absent reaches `record` unvalidated. `NaN` would serialise as `null` in
    // the JSON on /api/status, which reads as "no signal" instead of "a bad frame arrived".
    const m = new QualityMonitor();
    const { report } = m.record({ filePath: "/media/one.mp4" } as never, at);
    expect(report.totalFrames).toBe(0);
    expect(report.droppedFrames).toBe(0);
    expect(report.droppedPct).toBe(0);
    expect(report.degraded).toBe(false);
  });

  it("has no report before the kiosk sends one", () => {
    expect(new QualityMonitor().latest()).toBeNull();
  });

  it("withholds a report that belongs to a different clip than the one on screen", () => {
    // A verdict from the previous album, or from before a stop, would otherwise be served by
    // /api/status as though it described what is playing now.
    const m = new QualityMonitor();
    m.record(sample({ droppedFrames: 50 }), at);
    expect(m.latest("/media/one.mp4")?.droppedPct).toBe(5);
    expect(m.latest("/media/two.mp4")).toBeNull();
    expect(m.latest(null)).toBeNull();
    expect(m.latest()).not.toBeNull(); // unscoped still returns the last thing seen
  });
});

// regression: #216 — the verdict was computed from the browser's *lifetime* counters, so it
// described the whole life of the clip rather than the present. An operator reads this number to
// decide whether the change they just made helped, which is the one moment a lagging answer is
// worthless.
describe("QualityMonitor judges the last interval, not the life of the clip", () => {
  it("clears the verdict as soon as the drops actually stop", () => {
    // The #211 deploy, exactly: the Pi's panel was running at 3840x2160@30, so Chromium rescaled
    // every frame and lost ~5.5% of them. Forcing 1920x1080@60 stopped the drops dead — but
    // /api/status went on reporting `degraded` for five more samples (4.5 → 4.1 → 3.8 → 3.5 →
    // 3.3%), because the 285 frames already lost stayed in the numerator forever.
    const m = new QualityMonitor();
    const first = m.record(
      sample({ totalFrames: 5182, droppedFrames: 285 }),
      at,
    );
    expect(first.report.degraded).toBe(true); // 5.5% at 4K — the real problem, correctly reported

    // Panel forced to 1080p. Every frame decoded from here lands.
    for (const totalFrames of [5782, 6382, 6982, 7582, 8182]) {
      const { report } = m.record(
        sample({ totalFrames, droppedFrames: 285 }),
        at,
      );
      expect(report.droppedPct).toBe(0);
      expect(report.degraded).toBe(false);
    }
  });

  it("rates the frames decoded since the previous sample", () => {
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 1000, droppedFrames: 10 }), at);
    const { report } = m.record(
      sample({ totalFrames: 1300, droppedFrames: 25 }),
      at,
    );
    expect(report.intervalFrames).toBe(300);
    expect(report.intervalDroppedFrames).toBe(15);
    expect(report.droppedPct).toBe(5); // 15/300, not 25/1300
    expect(report.degraded).toBe(true);
  });

  it("still reports the cumulative counters the browser sent", () => {
    // They are what the kiosk measured, and "0% right now, 285 lost in total" is a more useful
    // sentence to an operator than either half alone — it is also what makes a droppedPct of 0
    // beside a big droppedFrames read as intended rather than as a bug.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 5182, droppedFrames: 285 }), at);
    const { report } = m.record(
      sample({ totalFrames: 5782, droppedFrames: 285 }),
      at,
    );
    expect(report.totalFrames).toBe(5782);
    expect(report.droppedFrames).toBe(285);
    expect(report.droppedPct).toBe(0);
  });

  it("treats counters that went backwards as a fresh clip, not a negative rate", () => {
    // The counters belong to the video *element* and reset when it gets a new source — so the same
    // file replayed, or handed to the other layer, restarts them near zero. Subtracting a stale
    // baseline from that would report a negative percentage.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 5182, droppedFrames: 285 }), at);
    const { report } = m.record(
      sample({ totalFrames: 300, droppedFrames: 21 }),
      at,
    );
    expect(report.intervalFrames).toBe(300);
    expect(report.intervalDroppedFrames).toBe(21);
    expect(report.droppedPct).toBe(7);
    expect(report.droppedPct).toBeGreaterThan(0);
  });

  it("re-baselines when only the dropped counter went backwards", () => {
    // A reset that happens to land above the old *total* still shows up here: dropped frames cannot
    // decrease within one clip, so a smaller number is a new source however the totals compare.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 300, droppedFrames: 50 }), at);
    const { report } = m.record(
      sample({ totalFrames: 350, droppedFrames: 2 }),
      at,
    );
    expect(report.intervalFrames).toBe(350);
    expect(report.intervalDroppedFrames).toBe(2);
    expect(report.degraded).toBe(false); // 0.6%, not the 50-frame interval a subtraction would give
  });

  it("baselines each clip on its own, so the album before doesn't count against it", () => {
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 5182, droppedFrames: 285 }), at);
    const { report } = m.record(
      sample({
        filePath: "/media/two.mp4",
        totalFrames: 300,
        droppedFrames: 3,
      }),
      at,
    );
    expect(report.intervalFrames).toBe(300);
    expect(report.droppedPct).toBe(1);
  });

  it("cannot report more frames dropped in an interval than were decoded in it", () => {
    // The counters are unvalidated input from the browser; a pair that disagrees must not become a
    // rate over 100%.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 1000, droppedFrames: 0 }), at);
    const { report } = m.record(
      sample({ totalFrames: 1010, droppedFrames: 500 }),
      at,
    );
    expect(report.intervalDroppedFrames).toBe(10);
    expect(report.droppedPct).toBe(100);
  });

  it("withholds judgement on an interval shorter than a real sample window", () => {
    // A partial window is what a clip that has only just come on screen produces. At 30 fps, 2% of
    // a 60-frame window is barely one frame — a single `loop` restart would read as degraded.
    const m = new QualityMonitor();
    m.record(sample({ totalFrames: 1000, droppedFrames: 0 }), at);
    const short = m.record(
      sample({ totalFrames: 1060, droppedFrames: 6 }),
      at,
    ).report;
    expect(short.intervalFrames).toBe(60);
    expect(short.droppedPct).toBe(10);
    expect(short.degraded).toBe(false);

    // The next full window judges it, so the verdict is delayed by one sample, not withheld.
    const full = m.record(
      sample({ totalFrames: 1060 + MIN_INTERVAL_FRAMES, droppedFrames: 26 }),
      at,
    ).report;
    expect(full.intervalFrames).toBe(MIN_INTERVAL_FRAMES);
    expect(full.degraded).toBe(true);
  });

  it("does not re-warn on every wobble across the threshold", () => {
    // Deltas are a much twitchier signal than a lifetime average: a board sitting near the
    // threshold would otherwise log a fresh warning every time it dipped under for one sample, and
    // an evening of that is the journal flood the once-per-clip rule exists to prevent. Recovery
    // has to be convincing — comfortably under the threshold, not a hair under it.
    const m = new QualityMonitor();
    let totalFrames = 0;
    let droppedFrames = 0;
    /** One more 1000-frame sample window, losing `dropped` frames in it. */
    const step = (dropped: number) => {
      totalFrames += 1000;
      droppedFrames += dropped;
      return m.record(sample({ totalFrames, droppedFrames }), at).newlyDegraded;
    };

    expect(step(50)).toBe(true); // 5%
    expect(step(19)).toBe(false); // 1.9% — under the line, but only just
    expect(step(50)).toBe(false); // 5% again: the same problem, not a new one
    expect(step(2)).toBe(false); // 0.2% — genuinely recovered, re-arms
    expect(step(50)).toBe(true); // a real relapse gets its line
  });

  it("re-arms at exactly the recovery bar, which is inclusive", () => {
    // Half the degraded threshold, to the decimal. The spec states the boundary, so it gets a case
    // rather than being left to whichever comparison operator got typed.
    const m = new QualityMonitor();
    expect(
      m.record(sample({ totalFrames: 1000, droppedFrames: 50 }), at)
        .newlyDegraded,
    ).toBe(true);
    m.record(sample({ totalFrames: 2000, droppedFrames: 60 }), at); // 10/1000 = 1.0% exactly
    expect(
      m.record(sample({ totalFrames: 3000, droppedFrames: 110 }), at)
        .newlyDegraded,
    ).toBe(true);
  });
});

// The examples above are the sequences we thought of. These are the ones we didn't.
//
// `record()` reads a WebSocket frame from the SPA — the one runtime on the Pi this repo doesn't
// build — so the input is an arbitrary pair of numbers arriving in an arbitrary order, not a
// well-behaved pair of monotonic counters. #216's own near-misses were all shapes of that: counters
// resetting, one counter moving without the other, a window of zero. A percentage that escapes
// [0, 100] would be served straight to `/api/status` and read as a decode verdict.
describe("QualityMonitor holds its invariants over any sequence of counters", () => {
  const counters = fc.record({
    filePath: fc.constantFrom("/media/one.mp4", "/media/two.mp4"),
    // Deliberately unsorted and unpaired: the browser is not obliged to be sensible, and neither is
    // a reconnecting one that starts a fresh element mid-clip.
    totalFrames: fc.integer({ min: -100, max: 20_000 }),
    droppedFrames: fc.integer({ min: -100, max: 20_000 }),
  });

  it("never reports a rate outside 0–100%, nor a negative window", () => {
    fc.assert(
      fc.property(
        fc.array(counters, { minLength: 1, maxLength: 40 }),
        (seq) => {
          const m = new QualityMonitor();
          for (const s of seq) {
            const { report } = m.record(s, at);
            expect(report.droppedPct).toBeGreaterThanOrEqual(0);
            expect(report.droppedPct).toBeLessThanOrEqual(100);
            expect(report.intervalFrames).toBeGreaterThanOrEqual(0);
            expect(report.intervalDroppedFrames).toBeGreaterThanOrEqual(0);
            expect(report.intervalDroppedFrames).toBeLessThanOrEqual(
              report.intervalFrames,
            );
            expect(Number.isFinite(report.droppedPct)).toBe(true);
          }
        },
      ),
    );
  });

  it("never calls a window degraded without the frames to justify it", () => {
    // The whole point of the floor: no sequence of counters may produce a `degraded` verdict off a
    // window too short to mean anything. This is what makes "delayed by one sample, never hidden"
    // a property rather than a hope.
    fc.assert(
      fc.property(
        fc.array(counters, { minLength: 1, maxLength: 40 }),
        (seq) => {
          const m = new QualityMonitor();
          for (const s of seq) {
            const { report } = m.record(s, at);
            if (report.degraded) {
              expect(report.intervalFrames).toBeGreaterThanOrEqual(
                MIN_INTERVAL_FRAMES,
              );
              expect(report.droppedPct).toBeGreaterThan(DEGRADED_PCT);
            }
          }
        },
      ),
    );
  });
});
