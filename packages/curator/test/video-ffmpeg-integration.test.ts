// Integration tests that shell out to the REAL ffmpeg/ffprobe. Everything else in the suite injects
// a fake `VideoProber`, which is fast and hermetic but cannot see whether the argv we build actually
// *works* — and that gap shipped a broken normalize: `buildNormalizeArgs` didn't pin `-f mp4`, so
// every real encode died on "Error initializing the muxer" against `ingestVideo`'s extensionless temp
// path, while all nine faked-prober tests stayed green (issue #180).
//
// So this file's job is narrow and specific: run the real binaries over the real code path, including
// the real temp filename. Skipped when ffmpeg isn't installed, which stays true on a workstation that
// never touches video — but it is no longer a local-only gate. CI installs ffmpeg and runs this file
// on the `test:integration` leg with `MARQUEE_REQUIRE_FFMPEG=1`, so a missing binary there is a red
// build rather than a silent skip. That skip is how #180 above, and #217 after it, both reached a
// release: for as long as no workflow installed ffmpeg, every assertion in here was inert on CI.
// See `ffmpeg-gate.ts`.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "../src/store/paths.js";
import { ffmpegGate } from "./ffmpeg-gate.js";
import {
  ffmpegProber,
  ingestVideo,
  budgetViolations,
  needsNormalize,
  DECODE_BUDGET,
  run,
} from "../src/media/video.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const hasFfmpeg = ffmpegGate();
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

/**
 * An over-*resolution* clip at an exact pixel size (regression: #217). Separate from
 * `makeOverBudgetClip` because the violation being provoked is different: no `noise`, no forced
 * bitrate — the size alone puts it outside `DECODE_BUDGET`, which is what routes it down the
 * downscale branch of `buildNormalizeArgs`.
 *
 * `frames` defaults to 1: the encoder rejects an odd frame geometry when it *opens*, so a single
 * frame proves as much as a hundred and keeps a 4096x2160 fixture from starving the rest of the
 * monorepo suite (see `makeOverBudgetClip` on why fixture cost matters here).
 */
async function makeOversizeClip(
  outPath: string,
  size: string,
  frames = 1,
): Promise<void> {
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=30`,
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mp4",
    outPath,
  ]);
}

/**
 * regression: #217 — the downscale branch had never been run against real ffmpeg.
 *
 * `scale=…:force_original_aspect_ratio=decrease` preserves aspect but does not guarantee *even*
 * dimensions, and libx264 with `-pix_fmt yuv420p` (4:2:0 chroma) refuses an odd width or height:
 * "height not divisible by 2 (1920x1013)". So a DCI-format upload — 2048x1080 and 4096x2160 are
 * ordinary NLE export targets — failed the encode outright and never reached the store.
 *
 * The old fixture is 320x240, deliberately small, and therefore never violates `resolution` — which
 * is exactly why nine green tests plus a real-binary integration file all missed this. These run the
 * real encoder over shapes that scale odd; a pure argv assertion cannot see the failure.
 */
describeFfmpeg(
  "normalize survives sources that scale to odd dimensions (#217)",
  () => {
    const paths = new Paths(mkdtempSync(join(tmpdir(), "curator-odd-")));

    // Each of these hits an odd result under plain `force_original_aspect_ratio=decrease`:
    // 2048x1080 and 4096x2160 both land on 1920x1013 (av_rescale rounds 1012.5 half-away-from-zero),
    // 3842x2160 on 1920x1079. 3840x2160 is the control — it already scales even, and must stay 1080p.
    const shapes = [
      { name: "DCI 2K", size: "2048x1080" },
      { name: "DCI 4K", size: "4096x2160" },
      { name: "near-UHD", size: "3842x2160" },
      { name: "UHD (control — already even)", size: "3840x2160" },
    ];

    it.each(shapes)(
      "encodes a $name ($size) source to an even, in-budget frame",
      async ({ size }) => {
        const src = join(paths.dataDir, `src-${size}.mp4`);
        await makeOversizeClip(src, size);

        const info = await ffmpegProber.probe(src);
        expect(budgetViolations(info)).toContain("resolution");

        const out = join(paths.dataDir, `out-${size}.tmp-abc123`);
        await ffmpegProber.normalize(src, out, info);

        const after = await ffmpegProber.probe(out);
        // The bug: this call threw before reaching here, so `after` never existed.
        expect(after.width % 2).toBe(0);
        expect(after.height % 2).toBe(0);
        // Still inside the budget it was downscaled to satisfy — rounding must never round *up* past it.
        expect(after.width).toBeLessThanOrEqual(DECODE_BUDGET.maxWidth);
        expect(after.height).toBeLessThanOrEqual(DECODE_BUDGET.maxHeight);
      },
      120_000,
    );

    /**
     * An **odd-dimensioned** H.264/MP4 that is nonetheless *inside* the resolution budget, so no
     * downscale runs. Legal because H.264 only forbids odd axes at 4:2:0 — `yuv444p` permits them (as
     * does conformance-cropped HEVC). `noise` + a forced bitrate supply the violation that makes ingest
     * re-encode it at all, the same trick `makeOverBudgetClip` uses and for the same reason. Kept tiny
     * (641x361): parity is a property of the geometry, not of the pixel count.
     */
    async function makeOddInBudgetClip(outPath: string): Promise<void> {
      await run(FFMPEG, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=1,noise=alls=100:allf=t+u",
        "-vf",
        "scale=641:361",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv444p",
        "-profile:v",
        "high444",
        "-b:v",
        "15M",
        "-minrate",
        "15M",
        "-maxrate",
        "15M",
        "-bufsize",
        "30M",
        "-f",
        "mp4",
        outPath,
      ]);
    }

    it("re-encodes an odd-but-in-budget source without a downscale to fall back on", async () => {
      // The widened half of #217: nothing here violates `resolution`, so the scale filter (and its
      // `force_divisible_by=2`) never runs — only the unconditional parity clamp saves the encode.
      const src = join(paths.dataDir, "odd-in-budget.mp4");
      await makeOddInBudgetClip(src);

      const info = await ffmpegProber.probe(src);
      expect(info.width % 2).toBe(1); // the fixture really is odd…
      expect(budgetViolations(info)).not.toContain("resolution"); // …and really does skip the scale
      expect(needsNormalize(info)).toBe(true);

      const out = join(paths.dataDir, "odd-in-budget-out.tmp-abc123");
      await ffmpegProber.normalize(src, out, info);

      const after = await ffmpegProber.probe(out);
      expect(after.width % 2).toBe(0);
      expect(after.height % 2).toBe(0);
      // Clamped, not rescaled — at most one pixel off each axis.
      expect(info.width - after.width).toBeLessThanOrEqual(1);
      expect(info.height - after.height).toBeLessThanOrEqual(1);
    }, 120_000);

    it("splices a clip set whose largest clip is odd-dimensioned", async () => {
      // `fitWithinBudget` is the splice's pad target. It used to pass an already-in-budget frame
      // through untouched — odd included — so the filter graph could not be configured at all.
      //
      // The odd clip must be the *largest* one: `resolveConcatBuild` takes the max width and height
      // across the set before calling `fitWithinBudget`, so pairing it with a bigger even clip hides
      // the bug entirely. (Written that way first; the mutation check is what caught it.)
      const odd = join(paths.dataDir, "splice-odd.mp4");
      const even = join(paths.dataDir, "splice-even.mp4");
      await makeOddInBudgetClip(odd);
      await makeOversizeClip(even, "320x240", 30);

      const out = join(paths.dataDir, "spliced.mp4");
      await ffmpegProber.concat([odd, even], out);

      const after = await ffmpegProber.probe(out);
      expect(after.width % 2).toBe(0);
      expect(after.height % 2).toBe(0);
      expect(after.codec).toBe("h264");
    }, 180_000);

    it("carries a DCI 2K upload all the way into the store", async () => {
      // The end-to-end shape of the bug report: the visualizer never reached `visualizers/`.
      const p = new Paths(mkdtempSync(join(tmpdir(), "curator-odd-ingest-")));
      const src = join(p.dataDir, "dci2k.mp4");
      await makeOversizeClip(src, "2048x1080", 30);

      const vis = await ingestVideo(
        {
          prober: ffmpegProber,
          paths: p,
          now: () => "2026-08-02T00:00:00.000Z",
        },
        { srcPath: src, fileId: "dddd4444", originalFilename: "dci2k.mp4" },
      );

      const stored = p.visualizerFile("dddd4444");
      expect(existsSync(stored)).toBe(true);
      const after = await ffmpegProber.probe(stored);
      expect(budgetViolations(after)).toEqual([]);
      expect(vis.resolution).toBe(`${after.width}x${after.height}`);
      expect(
        readdirSync(p.visualizers).filter((f) => f.includes(".tmp-")),
      ).toEqual([]);
    }, 180_000);
  },
);

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
