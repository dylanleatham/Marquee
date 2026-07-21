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
   * fail the join.
   */
  concat(files: string[], outPath: string): Promise<void>;
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
          new VideoError(`${bin} timed out after ${timeoutMs}ms and was killed`),
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

/**
 * Build the ffmpeg argv for concatenating `files` into one H.264/MP4 loop at `outPath`. Uses the
 * `concat` filter (not `-c copy`) so the output is always re-encoded to a uniform H.264 stream that
 * passes `validateVideo`, regardless of the inputs' individual encodings. Video-only (`a=0`).
 * Exported so tests assert the exact command without shelling out (mirrors `ffmpegAvailable`'s seam).
 * Inputs are assumed same-dimension (clips off one album cover); mismatched sizes are a follow-up.
 */
export function buildConcatArgs(files: string[], outPath: string): string[] {
  const inputs = files.flatMap((f) => ["-i", f]);
  const labels = files.map((_, i) => `[${i}:v]`).join("");
  const filter = `${labels}concat=n=${files.length}:v=1:a=0[out]`;
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
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

  async concat(files, outPath) {
    if (files.length === 0)
      throw new VideoError("no clips to splice into a loop");
    await run(FFMPEG, buildConcatArgs(files, outPath), CONCAT_TIMEOUT_MS);
  },
};
