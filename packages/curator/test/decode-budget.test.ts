// Regression tests for #180: visualizers reached the Pi at ~20 Mbps 1080p30 with an AAC track and
// glitched, because the Pi 5 software-decodes H.264 (no hardware decoder) and `ingestVideo` copied
// whatever it was handed. These pin the decode budget: what counts as over-budget, what argv the
// normalize runs, and that ingest normalizes an over-budget file but leaves a conformant one alone
// (the latter is what stops the splice path from encoding twice).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "../src/store/paths.js";
import {
  DECODE_BUDGET,
  budgetViolations,
  needsNormalize,
  buildNormalizeArgs,
  fitWithinBudget,
  parseFrameRate,
  ingestVideo,
  type VideoInfo,
  type VideoProber,
} from "../src/media/video.js";
import { fakeProber } from "./helpers.js";

const paths = () => new Paths(mkdtempSync(join(tmpdir(), "curator-budget-")));

/** A file that already fits the budget: 1080p30 H.264, well under the ceiling, no audio. */
const conformant: VideoInfo = {
  durationSec: 44,
  width: 1920,
  height: 1080,
  codec: "h264",
  container: "mov,mp4,m4a",
  bitRateBps: 7_300_000,
  fps: 30,
  hasAudio: false,
};

/** What every visualizer in the store actually looked like when #180 was filed. */
const asShipped: VideoInfo = {
  ...conformant,
  bitRateBps: 20_224_436,
  hasAudio: true,
};

describe("budgetViolations", () => {
  it("passes a file that already fits the budget", () => {
    expect(budgetViolations(conformant)).toEqual([]);
    expect(needsNormalize(conformant)).toBe(false);
  });

  it("flags the real-world file from #180 on bitrate and audio", () => {
    expect(budgetViolations(asShipped).sort()).toEqual(["audio", "bitrate"]);
    expect(needsNormalize(asShipped)).toBe(true);
  });

  it("flags oversize resolution, over-rate fps, and a non-H.264 codec", () => {
    expect(
      budgetViolations({ ...conformant, width: 3840, height: 2160 }),
    ).toEqual(["resolution"]);
    expect(budgetViolations({ ...conformant, fps: 60 })).toEqual(["fps"]);
    expect(budgetViolations({ ...conformant, codec: "hevc" })).toEqual([
      "codec",
    ]);
  });

  it("treats an unknown bitrate as over budget — an unprovable file is not a conformant one", () => {
    expect(budgetViolations({ ...conformant, bitRateBps: 0 })).toEqual([
      "bitrate",
    ]);
  });

  it("accepts a margin above the encode target so a normalized file is never re-encoded", () => {
    // The encode aims at `targetMaxrateBps`; the accept ceiling sits above it, otherwise a file we
    // just produced could probe a hair over its own target and get encoded again on every ingest.
    expect(DECODE_BUDGET.maxBitrateBps).toBeGreaterThan(
      DECODE_BUDGET.targetMaxrateBps,
    );
    expect(
      budgetViolations({
        ...conformant,
        bitRateBps: DECODE_BUDGET.targetMaxrateBps,
      }),
    ).toEqual([]);
  });
});

describe("parseFrameRate", () => {
  // ffprobe hands back a rational string, and the budget's fps check is only as good as this.
  it("reads ffprobe's rational strings, including NTSC rates", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("60/1")).toBe(60);
    expect(parseFrameRate("25")).toBe(25); // no denominator
  });

  it("returns 0 for the unknown and malformed forms rather than NaN", () => {
    // NaN would silently pass the `fps > max` check and let a 60fps file through as conformant.
    expect(parseFrameRate("0/0")).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate("")).toBe(0);
    expect(parseFrameRate("N/A")).toBe(0);
  });

  it("keeps 29.97 inside the budget but 60 outside it", () => {
    expect(
      budgetViolations({ ...conformant, fps: parseFrameRate("30000/1001") }),
    ).toEqual([]);
    expect(
      budgetViolations({ ...conformant, fps: parseFrameRate("60/1") }),
    ).toEqual(["fps"]);
  });
});

describe("buildNormalizeArgs", () => {
  it("caps the bitrate, strips audio, and writes a faststart 2s-GOP H.264", () => {
    const args = buildNormalizeArgs("in.mp4", "out.mp4", asShipped);
    expect(args).toContain("-an"); // muted at runtime; the AAC track is dead weight
    expect(args).toContain("-maxrate");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("8000000");
    expect(args).toContain("libx264");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("high");
    expect(args[args.indexOf("-g") + 1]).toBe("60");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("pins the output container, because the caller writes to a temp path with no .mp4 extension", () => {
    // `ingestVideo` encodes to `{dest}.tmp-{uuid}` and renames on success, so ffmpeg cannot infer the
    // muxer from the extension and fails with "Error initializing the muxer … Invalid argument".
    // Shipped without this, every real normalize failed while every faked-prober test passed.
    for (const info of [asShipped, { ...conformant, hasAudio: true }]) {
      const args = buildNormalizeArgs("in.mp4", "out.mp4.tmp-abc123", info);
      expect(args[args.indexOf("-f") + 1]).toBe("mp4");
    }
  });

  it("downscales an oversize input and pins the frame rate of an over-rate one", () => {
    const big = buildNormalizeArgs("in.mp4", "out.mp4", {
      ...asShipped,
      width: 3840,
      height: 2160,
      fps: 60,
    });
    const vf = big[big.indexOf("-vf") + 1] ?? "";
    expect(vf).toContain("scale=1920:1080");
    expect(vf).toContain("force_original_aspect_ratio=decrease");
    expect(big[big.indexOf("-r") + 1]).toBe("30");
  });

  it("forces the downscale to even dimensions, which yuv420p requires", () => {
    // regression: #217 — `force_original_aspect_ratio=decrease` preserves aspect but not *parity*,
    // and libx264 at `-pix_fmt yuv420p` (4:2:0 chroma) refuses an odd width or height outright:
    // "height not divisible by 2 (1920x1013)". DCI 2K (2048x1080) and DCI 4K (4096x2160) both scale
    // to exactly that, so every DCI-format upload failed the encode and never reached the store.
    //
    // This is the cheap tripwire; `video-ffmpeg-integration.test.ts` is what actually proves the
    // argv runs, because a string assertion cannot see ffmpeg reject the command.
    for (const size of [
      { width: 2048, height: 1080 }, // DCI 2K  → 1920x1013 unguarded
      { width: 4096, height: 2160 }, // DCI 4K  → 1920x1013 unguarded
      { width: 3842, height: 2160 }, //         → 1920x1079 unguarded
    ]) {
      const args = buildNormalizeArgs("in.mp4", "out.mp4", {
        ...conformant,
        ...size,
      });
      const vf = args[args.indexOf("-vf") + 1] ?? "";
      expect(vf).toContain("force_divisible_by=2");
    }
  });

  it("clamps parity even when the source is small enough to skip the downscale", () => {
    // regression: #217, widened. The `force_divisible_by=2` above only helps when `resolution` is a
    // violation — but a source can *already* be odd and inside the budget, because H.264 only forbids
    // odd dimensions at 4:2:0; 4:4:4 (and conformance-cropped HEVC) allow them. Such a file adds no
    // scale filter, so a re-encode triggered by any *other* violation re-encoded at the native odd
    // size and died the same way: "width not divisible by 2 (1919x1013)". Both HEVC and over-bitrate
    // uploads reach this path, and HEVC always does — it is a codec violation by definition.
    for (const info of [
      { ...conformant, width: 1919, height: 1013, bitRateBps: 20_000_000 },
      { ...conformant, width: 1919, height: 1013, codec: "hevc" },
      { ...conformant, width: 1919, height: 1013, fps: 60 },
    ]) {
      const args = buildNormalizeArgs("in.mp4", "out.mp4", info);
      const vf = args[args.indexOf("-vf") + 1] ?? "";
      expect(vf).toContain("crop=trunc(iw/2)*2:trunc(ih/2)*2");
      expect(vf).not.toContain("scale="); // still no needless downscale — it already fits
    }
  });

  it("remuxes rather than re-encodes when audio is the only thing out of budget", () => {
    // An NLE export that already fits the budget but carries a muted audio track must not pay a
    // full re-encode (and the quality loss) just to drop that track.
    const args = buildNormalizeArgs("in.mp4", "out.mp4", {
      ...conformant,
      hasAudio: true,
    });
    expect(args).toContain("-an");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args).not.toContain("libx264");
  });
});

/**
 * `fitWithinBudget` had no test at all, despite being the rule the *splice* path relies on to keep
 * libx264 fed with an even frame — it is the pad target every clip is normalized to. #217 was the
 * same mistake on the normalize path, so this pins the invariant the docstring already claims.
 */
describe("fitWithinBudget", () => {
  const shapes = [
    [3840, 2160], // UHD — exact halving
    [4096, 2160], // DCI 4K — the #217 shape
    [2048, 1080], // DCI 2K
    [3842, 2160],
    [1920, 1080], // already conformant
    [1919, 1013], // odd *and* already inside the budget (4:4:4 H.264 allows this)
    [1281, 721],
    [640, 480], // comfortably under
    [7680, 4320], // 8K
    [1, 1], // degenerate — must not produce a zero dimension
  ] as const;

  it.each(shapes)("returns an even, in-budget frame for %ix%i", (w, h) => {
    const fit = fitWithinBudget(w, h);
    // Even is the whole point: H.264 4:2:0 cannot encode an odd axis.
    expect(fit.width % 2).toBe(0);
    expect(fit.height % 2).toBe(0);
    // Rounding to even must never round *up* past the ceiling it exists to respect.
    expect(fit.width).toBeLessThanOrEqual(DECODE_BUDGET.maxWidth);
    expect(fit.height).toBeLessThanOrEqual(DECODE_BUDGET.maxHeight);
    // And never collapse to nothing.
    expect(fit.width).toBeGreaterThanOrEqual(2);
    expect(fit.height).toBeGreaterThanOrEqual(2);
  });

  it("preserves the aspect ratio to within the rounding it is allowed", () => {
    // Forcing even can move each axis by at most 1px, so the ratio may drift slightly — but a
    // downscale must never letterbox-by-stretch, which is what a real aspect bug would look like.
    for (const [w, h] of shapes) {
      const fit = fitWithinBudget(w, h);
      const drift = Math.abs(fit.width / fit.height - w / h) / (w / h);
      expect(drift).toBeLessThan(0.01);
    }
  });

  it("does not upscale a frame that already fits", () => {
    expect(fitWithinBudget(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitWithinBudget(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
});

/**
 * `fakeProber` with a normalize counter, so ingest's branch (encode vs verbatim copy) is observable.
 * Wraps rather than re-implements — same pattern as splice.test.ts's `recordingProber`.
 */
function budgetProber(info: VideoInfo): VideoProber & { normalized: number } {
  const base = fakeProber(info);
  const p: VideoProber & { normalized: number } = {
    ...base,
    normalized: 0,
    normalize: async (src, outPath, i) => {
      p.normalized += 1;
      return base.normalize(src, outPath, i);
    },
  };
  return p;
}

function stageSource(p: Paths): string {
  const src = join(p.incoming, "raw.mp4");
  mkdirSync(p.incoming, { recursive: true });
  writeFileSync(src, Buffer.from("ORIGINAL-20MBPS"));
  return src;
}

describe("ingestVideo enforces the decode budget", () => {
  it("normalizes an over-budget upload — the stored file is not the original bytes", async () => {
    const p = paths();
    const prober = budgetProber(asShipped);
    const vis = await ingestVideo(
      { prober, paths: p, now: () => "2026-07-29T00:00:00.000Z" },
      {
        srcPath: stageSource(p),
        fileId: "aaaa1111",
        originalFilename: "raw.mp4",
      },
    );
    expect(prober.normalized).toBe(1);
    expect(readFileSync(p.visualizerFile("aaaa1111"), "utf8")).toBe(
      "NORMALIZED",
    );
    expect(vis.fileId).toBe("aaaa1111");
  });

  it("copies a conformant file verbatim — so a spliced loop is never encoded twice", async () => {
    const p = paths();
    const prober = budgetProber(conformant);
    await ingestVideo(
      { prober, paths: p, now: () => "2026-07-29T00:00:00.000Z" },
      {
        srcPath: stageSource(p),
        fileId: "bbbb2222",
        originalFilename: "raw.mp4",
      },
    );
    expect(prober.normalized).toBe(0);
    expect(readFileSync(p.visualizerFile("bbbb2222"), "utf8")).toBe(
      "ORIGINAL-20MBPS",
    );
  });

  it("reports the resolution of the stored file, not the oversize source", async () => {
    const p = paths();
    // Probe is asked twice: once for the source, once for what actually landed on disk.
    let call = 0;
    const prober = budgetProber(asShipped);
    prober.probe = async () => {
      call += 1;
      return call === 1
        ? { ...asShipped, width: 3840, height: 2160 }
        : { ...conformant, width: 1920, height: 1080 };
    };
    const vis = await ingestVideo(
      { prober, paths: p, now: () => "2026-07-29T00:00:00.000Z" },
      {
        srcPath: stageSource(p),
        fileId: "cccc3333",
        originalFilename: "raw.mp4",
      },
    );
    expect(vis.resolution).toBe("1920x1080");
  });
});
