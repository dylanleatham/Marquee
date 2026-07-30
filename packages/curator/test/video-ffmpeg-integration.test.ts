// Integration tests that shell out to the REAL ffmpeg/ffprobe. Everything else in the suite injects
// a fake `VideoProber`, which is fast and hermetic but cannot see whether the argv we build actually
// *works* — and that gap shipped a broken normalize: `buildNormalizeArgs` didn't pin `-f mp4`, so
// every real encode died on "Error initializing the muxer" against `ingestVideo`'s extensionless temp
// path, while all nine faked-prober tests stayed green (issue #180).
//
// So this file's job is narrow and specific: run the real binaries over the real code path, including
// the real temp filename. Skipped when ffmpeg isn't installed — it's a local/dev gate, not a CI one.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "../src/store/paths.js";
import {
  ffmpegProber,
  ffmpegAvailable,
  ingestVideo,
  budgetViolations,
  run,
} from "../src/media/video.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const hasFfmpeg = ffmpegAvailable();
const describeFfmpeg = hasFfmpeg ? describe : describe.skip;

/**
 * A deliberately over-budget clip: bitrate forced well past the ceiling, plus an audio track.
 *
 * Kept **small and short on purpose**: a 1080p fixture encoding in parallel with the rest of the
 * monorepo suite starved Backdrop's timing-sensitive server/ws tests into a flake, and a test that
 * destabilises its neighbours isn't worth the fidelity it buys. Downscaling behaviour is covered by
 * the pure `buildNormalizeArgs` tests instead.
 *
 * The `noise` filter is what makes a 320x240 clip genuinely exceed the bitrate ceiling (~30 Mbps
 * measured, in ~130ms). Asking for `-b:v 15M` alone doesn't do it — x264 cannot *fill* a high bitrate
 * with content as compressible as bare `testsrc2`, so the clip came out under the ceiling, the bitrate
 * violation never fired, and the test quietly fell through to the remux path instead of the re-encode
 * path it exists to cover. That is what the "really is over budget" test below guards.
 *
 * `*.mp4` is gitignored repo-wide, so fixtures are generated rather than committed.
 */
async function makeOverBudgetClip(outPath: string, seconds = 1): Promise<void> {
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=30:duration=${seconds},noise=alls=100:allf=t+u`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "15M",
    "-minrate",
    "15M",
    "-maxrate",
    "15M",
    "-bufsize",
    "30M",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-f",
    "mp4",
    outPath,
  ]);
}

describeFfmpeg("ingestVideo against real ffmpeg", () => {
  const paths = new Paths(mkdtempSync(join(tmpdir(), "curator-ffmpeg-")));
  let src: string;

  beforeAll(async () => {
    src = join(paths.dataDir, "over-budget.mp4");
    await makeOverBudgetClip(src);
  }, 120_000);

  it("produces a fixture that really is over budget", async () => {
    const info = await ffmpegProber.probe(src);
    expect(info.codec).toBe("h264");
    expect(info.hasAudio).toBe(true);
    expect(budgetViolations(info)).toContain("bitrate");
  });

  it("normalizes it end to end, through the real extensionless temp path", async () => {
    const vis = await ingestVideo(
      { prober: ffmpegProber, paths, now: () => "2026-07-29T00:00:00.000Z" },
      { srcPath: src, fileId: "aaaa1111", originalFilename: "over-budget.mp4" },
    );

    const stored = paths.visualizerFile("aaaa1111");
    expect(existsSync(stored)).toBe(true);

    // The whole point: what landed is inside the budget, so Backdrop can decode it in software.
    const after = await ffmpegProber.probe(stored);
    expect(budgetViolations(after)).toEqual([]);
    expect(after.hasAudio).toBe(false);
    expect(vis.resolution).toBe("320x240"); // reported from the stored file, not assumed

    // And no temp file survived the rename.
    expect(
      readdirSync(paths.visualizers).filter((f) => f.includes(".tmp-")),
    ).toEqual([]);
  }, 180_000);

  it("leaves nothing behind in visualizers/ when the source is unreadable", async () => {
    const p = new Paths(mkdtempSync(join(tmpdir(), "curator-ffmpeg-bad-")));
    await expect(
      ingestVideo(
        {
          prober: ffmpegProber,
          paths: p,
          now: () => "2026-07-29T00:00:00.000Z",
        },
        {
          srcPath: join(p.dataDir, "does-not-exist.mp4"),
          fileId: "bbbb2222",
          originalFilename: "nope.mp4",
        },
      ),
    ).rejects.toThrow();
    expect(existsSync(p.visualizers) ? readdirSync(p.visualizers) : []).toEqual(
      [],
    );
  });
});

describe("run() error reporting", () => {
  it("surfaces the end of stderr, where ffmpeg puts the actual error", async () => {
    // ffmpeg opens with ~15 lines of version/configuration banner and puts the real cause last. The
    // message used to carry the first 300 chars — i.e. always the banner — which is exactly why the
    // muxer failure above read as an unexplained numeric exit code.
    if (!hasFfmpeg) return;
    const err = await run(FFMPEG, ["-i", "definitely-not-a-file.mp4"]).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /No such file or directory|Invalid/i,
    );
  });
});
