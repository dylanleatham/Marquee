// Video ingest (curator-spec §9): probe → validate (H.264/H.265 in MP4) → thumbnail → place in
// visualizers/. The prober is an interface so tests inject a fake and never shell out to ffmpeg
// (same pattern as the Spotify/palette fakes); production uses FfmpegProber over the real binaries.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import type { Paths } from "../store/paths.js";
import type { VisualizerSection } from "../albums/asset.js";

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
  codec: string; // e.g. "h264", "hevc"
  container: string; // e.g. "mov,mp4,m4a,…"
}

export interface VideoProber {
  probe(file: string): Promise<VideoInfo>;
  /** Write a `width`px-wide JPEG frame from `file` at `atSec` seconds to `outPath`. */
  thumbnail(
    file: string,
    outPath: string,
    atSec: number,
    width: number,
  ): Promise<void>;
  /**
   * Concatenate `files` (in order) into one H.264/MP4 at `outPath`, re-encoding for a uniform loop
   * (issue #29). Video-only — the runtime visualizer plays muted — so audio-stream mismatches can't
   * fail the join. Mismatched input dimensions are normalized to a common size, and `crossfade`
   * blends the seams instead of hard-cutting (issue #56).
   */
  concat(files: string[], outPath: string, opts?: ConcatOptions): Promise<void>;
}

/** User-facing splice options (issue #56). Dimension normalization is automatic; crossfade is opt-in. */
export interface ConcatOptions {
  /** Blend each seam over this many seconds with an `xfade` instead of a hard cut. Omit for a plain
   * concat (the default). */
  crossfade?: { durationSec: number };
}

/** A rejected upload — bad container/codec or an unreadable file. Surfaced to the UI as 422. */
export class VideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoError";
  }
}

const ALLOWED_CODECS = new Set(["h264", "hevc"]); // H.264 always; H.265 for Pi 5 (spec §9)

/** Enforce the runtime's format contract: an MP4 container carrying H.264 (or H.265). */
export function validateVideo(info: VideoInfo): void {
  if (!info.container.split(",").includes("mp4"))
    throw new VideoError(
      `Video must be an MP4 container (got "${info.container}"). Re-export as MP4.`,
    );
  if (!ALLOWED_CODECS.has(info.codec))
    throw new VideoError(
      `Video codec must be H.264 or H.265 (got "${info.codec}"). Re-encode to H.264.`,
    );
}

/**
 * Ingest a raw uploaded/incoming video into the store: probe + validate, copy to
 * `visualizers/{fileId}.mp4`, render a midpoint thumbnail, and return the asset's visualizer
 * section. On a validation failure nothing is written. Optionally removes the source afterwards.
 */
export async function ingestVideo(
  deps: { prober: VideoProber; paths: Paths; now?: () => string },
  args: {
    srcPath: string;
    fileId: string;
    originalFilename: string;
    removeSrc?: boolean;
  },
): Promise<VisualizerSection> {
  const info = await deps.prober.probe(args.srcPath);
  validateVideo(info);

  mkdirSync(deps.paths.visualizers, { recursive: true });
  const dest = deps.paths.visualizerFile(args.fileId);
  copyFileSync(args.srcPath, dest);

  mkdirSync(deps.paths.thumbnails, { recursive: true });
  const at = info.durationSec > 0 ? info.durationSec / 2 : 0;
  try {
    await deps.prober.thumbnail(
      dest,
      deps.paths.thumbnailFile(args.fileId),
      at,
      320,
    );
  } catch {
    // A missing thumbnail is cosmetic — the preview still plays. Don't fail the attach over it.
  }
  if (args.removeSrc) rmSync(args.srcPath, { force: true });

  const now = (deps.now ?? (() => new Date().toISOString()))();
  return {
    fileId: args.fileId,
    originalFilename: args.originalFilename,
    durationSec: Math.round(info.durationSec),
    resolution: `${info.width}x${info.height}`,
    loopStrategy: "loop",
    attachedAt: now,
  };
}

// --- Real ffprobe/ffmpeg implementation ---------------------------------------------------------

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const IS_WIN = process.platform === "win32";

// Resolve a bare command to something CreateProcess can find on Windows without a shell: append
// `.exe` when there's no directory and no extension. Full paths (FFPROBE_PATH) pass through.
const resolveBin = (bin: string): string =>
  IS_WIN && !/[\\/]/.test(bin) && !/\.[a-z0-9]+$/i.test(bin)
    ? `${bin}.exe`
    : bin;

// Default wall-clock cap for an ffmpeg/ffprobe invocation. Probe + thumbnail are quick; the splice
// concat re-encodes several clips and gets a larger budget (CONCAT_TIMEOUT_MS). Curator is an
// always-on service — a hung or pathologically-slow binary (corrupt input, mismatched clips) must
// not tie up the request/event loop forever, so every run is killed past its budget (runtime review).
const RUN_TIMEOUT_MS = 60_000;
const CONCAT_TIMEOUT_MS = 300_000;

/**
 * Run a binary with argv passed directly — **never through a shell** — so a filename can't inject
 * commands (security review, step 7). Args are handed to CreateProcess/execvp verbatim; spaces and
 * shell metacharacters in paths are inert. The process is killed if it exceeds `timeoutMs`, so a
 * stuck encode surfaces as a `VideoError` instead of blocking the caller indefinitely. `spawnFn` is
 * injectable (mirroring `ffmpegAvailable`) so the timeout path is testable without shelling out.
 */
export function run(
  bin: string,
  args: string[],
  timeoutMs: number = RUN_TIMEOUT_MS,
  spawnFn: typeof spawn = spawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(resolveBin(bin), args, { windowsHide: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new VideoError(
          `Could not run ${bin} (${(e as Error).message}). Is ffmpeg installed and on PATH?`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        return reject(
          new VideoError(
            `${bin} timed out after ${timeoutMs}ms and was killed`,
          ),
        );
      code === 0
        ? resolve(out)
        : reject(new VideoError(`${bin} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Is ffprobe runnable? Backs the startup warning. `spawn` is injectable (mirroring VideoProber) so
 * tests never shell out, and the probe is capped by a timeout: this is a *synchronous* spawn, so a
 * hung ffprobe would otherwise block the event loop. Callers run it before accepting requests.
 */
export function ffmpegAvailable(spawn: typeof spawnSync = spawnSync): boolean {
  try {
    return (
      spawn(resolveBin(FFPROBE), ["-version"], {
        windowsHide: true,
        timeout: 5_000,
      }).status === 0
    );
  } catch {
    // Missing or unspawnable binary — that *is* the answer ("no ffmpeg"), not an error to surface.
    return false;
  }
}

/** Fully-resolved concat options (the prober fills these from probing each input; issue #56). */
export interface BuildConcatArgs {
  /** Scale + pad every input to this pixel size before joining — for mismatched clip dimensions.
   * Omit when the inputs are known same-size (keeps the plain, minimal filtergraph). */
  size?: { width: number; height: number };
  /** Crossfade consecutive clips at the seam. `durations` is the per-input length (seconds), needed
   * to place each transition's offset. */
  crossfade?: { durationSec: number; durations: number[] };
}

/**
 * Build the ffmpeg argv for joining `files` into one H.264/MP4 loop at `outPath`. Uses the filter
 * graph (not `-c copy`) so the output is always re-encoded to a uniform H.264 stream that passes
 * `validateVideo`, regardless of the inputs' individual encodings. Video-only (`a=0`).
 *
 * With `size`, each input is scaled to fit + padded to a common frame (mismatched clip dimensions,
 * issue #56) — `xfade`/`concat` both require identical geometry, so this is required whenever the
 * inputs might differ. With `crossfade`, consecutive clips blend at the seam via `xfade` instead of a
 * hard cut. Neither → the original plain `concat` (the default). Exported so tests assert the exact
 * command without shelling out (mirrors `ffmpegAvailable`'s seam).
 */
export function buildConcatArgs(
  files: string[],
  outPath: string,
  opts: BuildConcatArgs = {},
): string[] {
  const inputs = files.flatMap((f) => ["-i", f]);
  const n = files.length;
  const { size, crossfade } = opts;

  // Per-input normalization: with a target size, each `[k:v]` becomes a scaled+padded `[vk]`; without
  // one we reference `[k:v]` directly (keeps the minimal graph for known same-size clips).
  const pre: string[] = [];
  const labels = files.map((_, i) => {
    if (!size) return `[${i}:v]`;
    pre.push(
      `[${i}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
        `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
    );
    return `[v${i}]`;
  });

  let graph: string[];
  if (crossfade && n > 1) {
    // xfade chain: overlap each seam by `d`s. The k-th transition (joining clip k) starts at
    // offset = (sum of the clips already placed) − k·d, since each xfade shortens the timeline by d.
    const d = crossfade.durationSec;
    const dur = crossfade.durations;
    let prev = labels[0]!;
    let placed = dur[0] ?? 0;
    graph = [...pre];
    for (let k = 1; k < n; k++) {
      const out = k === n - 1 ? "[out]" : `[x${k}]`;
      const offset = Math.max(0, placed - d).toFixed(3);
      graph.push(
        `${prev}${labels[k]}xfade=transition=fade:duration=${d}:offset=${offset}${out}`,
      );
      placed += (dur[k] ?? 0) - d;
      prev = out;
    }
  } else {
    graph = [...pre, `${labels.join("")}concat=n=${n}:v=1:a=0[out]`];
  }

  return [
    "-y",
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

export const ffmpegProber: VideoProber = {
  async probe(file) {
    const json = await run(FFPROBE, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    let parsed: {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }>;
    };
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new VideoError(
        "Could not read video metadata (ffprobe returned no JSON).",
      );
    }
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    if (!video) throw new VideoError("File has no video stream.");
    return {
      durationSec: Number(parsed.format?.duration ?? 0),
      width: video.width ?? 0,
      height: video.height ?? 0,
      codec: video.codec_name ?? "unknown",
      container: parsed.format?.format_name ?? "unknown",
    };
  },

  async thumbnail(file, outPath, atSec, width) {
    await run(FFMPEG, [
      "-y",
      "-ss",
      String(atSec),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-1`,
      outPath,
    ]);
  },

  async concat(files, outPath, opts = {}) {
    if (files.length === 0)
      throw new VideoError("no clips to splice into a loop");
    // Probe every input up front (issue #56) to resolve normalization + crossfade timing. A single
    // clip needs neither, so it skips the probe and takes the plain path.
    const build =
      files.length > 1
        ? resolveConcatBuild(
            await Promise.all(files.map((f) => this.probe(f))),
            opts,
          )
        : {};
    await run(
      FFMPEG,
      buildConcatArgs(files, outPath, build),
      CONCAT_TIMEOUT_MS,
    );
  },
};

/**
 * Decide the concat build from the probed inputs (issue #56): normalize to the largest frame only
 * when the clips actually differ (same-size clips keep the minimal filtergraph and original argv),
 * and — for a crossfade, which requires identical geometry — always normalize and carry the per-clip
 * durations that place each seam. Pure, so the decision is unit-tested without shelling out.
 */
export function resolveConcatBuild(
  infos: VideoInfo[],
  opts: ConcatOptions = {},
): BuildConcatArgs {
  if (infos.length <= 1) return {};
  const width = Math.max(...infos.map((i) => i.width));
  const height = Math.max(...infos.map((i) => i.height));
  const uniform = infos.every((i) => i.width === width && i.height === height);
  const build: BuildConcatArgs = {};
  if (!uniform || opts.crossfade) build.size = { width, height };
  if (opts.crossfade)
    build.crossfade = {
      durationSec: opts.crossfade.durationSec,
      durations: infos.map((i) => i.durationSec),
    };
  return build;
}
