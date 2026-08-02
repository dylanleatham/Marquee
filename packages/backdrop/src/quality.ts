// How playback actually went on the Pi (issue #211).
//
// [ADR 0040](../../../docs/adrs/0040-visualizers-carry-a-decode-budget.md) established that Curator's
// preview cannot catch a decode-budget defect — it runs on a workstation with a hardware decoder,
// which doesn't care — and made the ingest budget the substitute for that missing signal. But a
// budget is a guess until something measures the result, and nothing did: the only report of a
// glitch was a human watching the display. That is also how that ADR's GPU flags shipped on
// reasoning alone and booted the kiosk to a black screen.
//
// Chromium answers the question directly. `HTMLVideoElement.getVideoPlaybackQuality()` returns how
// many frames the decoder was handed and how many it had to drop; on a board that decodes H.264 in
// software, dropped frames *are* the stutter. The kiosk reports the counters, this turns them into a
// verdict, and `/api/status` serves it — so "is it still glitchy?" has a number behind it.

/** One report from the kiosk. Counters are cumulative for the clip currently on screen. */
export interface QualitySample {
  filePath: string;
  totalFrames: number;
  droppedFrames: number;
}

export interface QualityReport extends QualitySample {
  /** Dropped as a percentage of total, rounded to one decimal. `0` when no frames were decoded. */
  droppedPct: number;
  /** Over `DEGRADED_PCT` — the clip is visibly stuttering, not merely imperfect. */
  degraded: boolean;
  /** When the sample was taken, ISO-8601. */
  at: string;
}

/**
 * The threshold at which dropped frames stop being noise and become the reported symptom.
 *
 * A software decoder that is keeping up drops essentially nothing; a couple of frames around a
 * `loop` restart or a layer swap is normal and should not cry wolf. Sustained loss above this is
 * roughly one visible hitch per second at 30 fps, which is what "flickers, stutters, or tears
 * throughout" looks like from the sofa.
 *
 * Deliberately **not** in `config.toml`, unlike the operational limits next door (idle timeout,
 * upload cap, stall window). Those are per-deployment choices; this is a fact about human vision at
 * 30 fps, identical on every board. A knob here would only let an installation silence the one
 * signal it has.
 */
export const DEGRADED_PCT = 2;

/** Ignore a sample this short: percentages off a handful of frames swing wildly and mean nothing. */
const MIN_FRAMES = 30;

/**
 * Keeps the most recent playback-quality report, and says when a clip first goes degraded so the
 * backend can log it exactly once rather than on every sample.
 *
 * Deliberately not a rolling average or a history: the operator question is "is the thing on screen
 * right now dropping frames", and one current number answers it. Anything longer-lived belongs in
 * whatever collects `journalctl`, not in a Pi's memory.
 */
export class QualityMonitor {
  private last: QualityReport | null = null;
  /** The file we have already warned about, so a steady-state problem logs once per clip. */
  private warnedFor: string | null = null;

  /**
   * Fold in a sample. Returns the report, plus whether this is the first sample to find this clip
   * degraded — the caller's cue to log. A too-short sample is recorded but never newly-degraded.
   */
  record(
    sample: QualitySample,
    now: () => string = isoNow,
  ): {
    report: QualityReport;
    newlyDegraded: boolean;
  } {
    const total = count(sample.totalFrames);
    const dropped = Math.min(total, count(sample.droppedFrames));
    const droppedPct =
      total === 0 ? 0 : Math.round((dropped / total) * 1000) / 10;
    const degraded = total >= MIN_FRAMES && droppedPct > DEGRADED_PCT;

    const report: QualityReport = {
      filePath: sample.filePath,
      totalFrames: total,
      droppedFrames: dropped,
      droppedPct,
      degraded,
      at: now(),
    };
    // A different clip is a fresh verdict — the previous one's warning says nothing about this one.
    const newlyDegraded = degraded && this.warnedFor !== sample.filePath;
    if (newlyDegraded) this.warnedFor = sample.filePath;
    else if (!degraded && this.warnedFor === sample.filePath)
      this.warnedFor = null;

    this.last = report;
    return { report, newlyDegraded };
  }

  /**
   * The most recent report, or `null` if the kiosk has never sent one.
   *
   * `forFilePath` scopes it to what is actually on screen: a verdict left over from the previous
   * album, or from before a stop, says nothing about now, and reporting it as current would be worse
   * than reporting nothing.
   */
  latest(forFilePath?: string | null): QualityReport | null {
    if (!this.last) return null;
    if (forFilePath !== undefined && this.last.filePath !== forFilePath)
      return null;
    return this.last;
  }
}

const isoNow = (): string => new Date().toISOString();

/**
 * A frame count, whatever the browser actually sent. Nothing validates a WebSocket frame on the way
 * in and the SPA is the one runtime on this box we don't build — a missing field must read as zero,
 * not propagate `NaN` into a percentage that then serialises as `null` on /api/status.
 */
const count = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
