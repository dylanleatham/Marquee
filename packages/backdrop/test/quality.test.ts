// The playback-quality signal (issue #211). ADR 0040 shipped a decode budget with nothing measuring
// whether it worked; this is that measurement, so the rules for turning raw counters into a verdict
// are worth pinning.
import { describe, it, expect } from "vitest";
import { QualityMonitor, DEGRADED_PCT } from "../src/quality.js";

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
    // fill the journal with the same warning several hundred times.
    const m = new QualityMonitor();
    expect(m.record(sample({ droppedFrames: 50 }), at).newlyDegraded).toBe(
      true,
    );
    expect(m.record(sample({ droppedFrames: 90 }), at).newlyDegraded).toBe(
      false,
    );
    expect(m.record(sample({ droppedFrames: 130 }), at).newlyDegraded).toBe(
      false,
    );
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
    const m = new QualityMonitor();
    m.record(sample({ droppedFrames: 50 }), at);
    m.record(sample({ totalFrames: 2000, droppedFrames: 50 }), at); // 2.5% → still degraded
    m.record(sample({ totalFrames: 10000, droppedFrames: 50 }), at); // 0.5% → recovered
    expect(m.record(sample({ droppedFrames: 50 }), at).newlyDegraded).toBe(
      true,
    );
  });

  it("does not judge a sample too short to mean anything", () => {
    // One dropped frame out of ten is 10%, and says nothing — a `loop` restart alone can cost that.
    const m = new QualityMonitor();
    const { report, newlyDegraded } = m.record(
      sample({ totalFrames: 10, droppedFrames: 1 }),
      at,
    );
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
