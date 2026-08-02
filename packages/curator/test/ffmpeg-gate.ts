import { ffmpegAvailable } from "../src/media/video.js";

/**
 * Resolve the ffmpeg gate the real-binary tests hang off, and refuse to skip silently when the
 * caller has declared ffmpeg mandatory.
 *
 * Skipping is the right answer on a workstation that hasn't installed ffmpeg — `pnpm test` should
 * not fail for a contributor who never touches video. On CI it is the wrong answer for a much worse
 * reason: a skipped suite and a passing suite are the same shade of green, and no workflow installed
 * ffmpeg, so *every* real-binary test in this package was inert. Two defects shipped through that
 * hole — #180 (`buildNormalizeArgs` never pinned `-f mp4`, so every real encode died on the muxer)
 * and #217 (the downscale emitted odd dimensions and libx264 refused them). Both were invisible to
 * the faked-prober tests, which assert on argv strings and cannot watch ffmpeg reject them.
 *
 * So CI sets `MARQUEE_REQUIRE_FFMPEG=1` and the skip becomes a hard failure. That is the durable
 * part of the fix: installing ffmpeg closes the gap today, but only this turns a future regression
 * — a broken apt step, a changed runner image, someone dropping the install line — back into a red
 * build instead of a quiet green one.
 *
 * Note that `MARQUEE_REQUIRE_FFMPEG` must be declared in `turbo.json`'s `test:integration` `env`
 * list to survive the trip: turbo runs in strict env mode and strips anything undeclared, so an
 * undeclared variable set in the workflow never reaches vitest at all.
 *
 * Both arguments are injected rather than read directly so the guard itself is testable without
 * shelling out or mutating `process.env` — the same seam `ffmpegAvailable` offers for `spawnSync`.
 */
export function ffmpegGate(
  available: boolean = ffmpegAvailable(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!available && env.MARQUEE_REQUIRE_FFMPEG === "1") {
    throw new Error(
      "MARQUEE_REQUIRE_FFMPEG=1, but ffprobe did not answer, so the real-binary tests would have " +
        "skipped silently — which is the failure mode this flag exists to prevent. Install ffmpeg " +
        "on PATH (on CI that is the 'Install ffmpeg' step in .github/workflows/ci.yml), or point " +
        "FFPROBE_PATH / FFMPEG_PATH at it.",
    );
  }
  return available;
}
