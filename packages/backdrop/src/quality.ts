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
//
// The counters are **cumulative** for the video element, and the verdict is deliberately not: it
// describes the interval since the previous sample. Judging the lifetime ratio made the number lag
// reality by minutes ([#216](https://github.com/dylanleatham/Marquee/issues/216)) — a Pi whose 4K
// panel had it rescaling every frame kept reporting `degraded` for five samples after the panel was
// forced to 1080p and the drops stopped dead, because 285 frames already lost stayed in the
// numerator. That is precisely the moment the number is being read: someone just changed something
// and wants to know whether it helped. The cumulative pair is still reported alongside.

/** One report from the kiosk. Counters are cumulative for the clip currently on screen. */
export interface QualitySample {
  filePath: string;
  totalFrames: number;
  droppedFrames: number;
}

export interface QualityReport extends QualitySample {
  /** Frames decoded since the previous sample — the window everything below is measured over. */
  intervalFrames: number;
  /** Frames lost in that window. */
  intervalDropped: number;
  /**
   * `intervalDropped` as a percentage of `intervalFrames`, rounded to one decimal. `0` when no
   * frames were decoded in the window.
   */
  droppedPct: number;
  /** Over `DEGRADED_PCT` **right now** — the clip is visibly stuttering, not merely imperfect. */
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

/**
 * A verdict needs this many frames in the window behind it, half a sample interval at 30 fps.
 *
 * The kiosk samples every 10 s, so a healthy window is ~300 frames at 30 fps and ~600 at 60 — the
 * only short ones come from a clip that has just arrived on screen. Percentages off a handful of
 * frames swing wildly and mean nothing: at 60 frames, the two a `loop` restart can cost already
 * reads as degraded. A window under the bar is still reported, just not judged, and the next full
 * one judges it — so a real problem is delayed by one sample, never hidden.
 */
export const MIN_INTERVAL_FRAMES = 150;

/**
 * Recovery has to clear this, not merely dip under `DEGRADED_PCT`.
 *
 * Per-interval rates are a far twitchier signal than the lifetime average they replaced
 * ([#216](https://github.com/dylanleatham/Marquee/issues/216)): a board sitting near the threshold
 * crosses it in both directions all evening. Without hysteresis each dip would re-arm the warning
 * and the next sample would spend it, which is the journal flood `warnedFor` exists to prevent.
 */
const RE_ARM_PCT = DEGRADED_PCT / 2;

/** Counters as they read at the start of a window. A clip with no history starts here. */
const FRESH: Counters = { totalFrames: 0, droppedFrames: 0 };

interface Counters {
  totalFrames: number;
  droppedFrames: number;
}

/**
 * Keeps the most recent playback-quality report, and says when a clip first goes degraded so the
 * backend can log it exactly once rather than on every sample.
 *
 * Deliberately not a rolling average or a history: the operator question is "is the thing on screen
 * right now dropping frames", and one current number answers it. Anything longer-lived belongs in
 * whatever collects `journalctl`, not in a Pi's memory. Exactly one sample is remembered, and only
 * as the baseline the next window is measured against.
 */
export class QualityMonitor {
  private last: QualityReport | null = null;
  /** Where the counters stood at the last sample — the start of the window being judged. */
  private previous: QualitySample | null = null;
  /** The file we have already warned about, so a steady-state problem logs once per clip. */
  private warnedFor: string | null = null;

  /**
   * Fold in a sample. Returns the report, plus whether this is the first sample to find this clip
   * degraded — the caller's cue to log. A too-short interval is recorded but never newly-degraded.
   */
  record(
    sample: QualitySample,
    now: () => string = isoNow,
  ): {
    report: QualityReport;
    newlyDegraded: boolean;
  } {
    const totalFrames = count(sample.totalFrames);
    const droppedFrames = Math.min(totalFrames, count(sample.droppedFrames));

    const base = this.baselineFor(sample.filePath, totalFrames, droppedFrames);
    const intervalFrames = totalFrames - base.totalFrames;
    // Clamped because the counters are unvalidated browser input and need not agree with each
    // other; more lost than decoded in a window would otherwise read as over 100%.
    const intervalDropped = Math.min(
      intervalFrames,
      droppedFrames - base.droppedFrames,
    );
    const droppedPct =
      intervalFrames === 0
        ? 0
        : Math.round((intervalDropped / intervalFrames) * 1000) / 10;
    const judged = intervalFrames >= MIN_INTERVAL_FRAMES;
    const degraded = judged && droppedPct > DEGRADED_PCT;

    const report: QualityReport = {
      filePath: sample.filePath,
      totalFrames,
      droppedFrames,
      intervalFrames,
      intervalDropped,
      droppedPct,
      degraded,
      at: now(),
    };
    // A different clip is a fresh verdict — the previous one's warning says nothing about this one.
    const newlyDegraded = degraded && this.warnedFor !== sample.filePath;
    if (newlyDegraded) this.warnedFor = sample.filePath;
    else if (
      this.warnedFor === sample.filePath &&
      judged &&
      droppedPct <= RE_ARM_PCT
    )
      this.warnedFor = null;

    this.previous = { filePath: sample.filePath, totalFrames, droppedFrames };
    this.last = report;
    return { report, newlyDegraded };
  }

  /**
   * Where to measure this window from.
   *
   * The counters belong to the video *element* and reset when it gets a new source, so the previous
   * sample is only a valid baseline while both counters are still climbing on the same clip.
   * Anything else — the next album, the same file replayed onto the other layer, a stop and a
   * restart — has already reset them, and the numbers that arrive are measured from that reset.
   * Subtracting a stale baseline from those would report a negative rate; the sample is its own
   * window instead. (Dropped frames cannot decrease within a clip, so a smaller one is a reset even
   * when the total happens to land above the old one.)
   */
  private baselineFor(
    filePath: string,
    totalFrames: number,
    droppedFrames: number,
  ): Counters {
    const prev = this.previous;
    const continues =
      prev !== null &&
      prev.filePath === filePath &&
      totalFrames >= prev.totalFrames &&
      droppedFrames >= prev.droppedFrames;
    return continues ? prev : FRESH;
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
