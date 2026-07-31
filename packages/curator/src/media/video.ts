// Video ingest (curator-spec §9): probe → validate (H.264/H.265 in MP4) → thumbnail → place in
// visualizers/. The prober is an interface so tests inject a fake and never shell out to ffmpeg
// (same pattern as the Spotify/palette fakes); production uses FfmpegProber over the real binaries.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Paths } from "../store/paths.js";
import type { VisualizerSection } from "../albums/asset.js";

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
  codec: string; // e.g. "h264", "hevc"
  container: string; // e.g. "mov,mp4,m4a,…"
  /** Video bitrate in bits/sec. `0` means ffprobe couldn't determine it — treated as over budget. */
  bitRateBps: number;
  /** Frames per second from `avg_frame_rate`; `0` when unknown. */
  fps: number;
  /** Does the file carry an audio stream? The runtime plays muted, so it's always stripped. */
  hasAudio: boolean;
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
   * Re-encode (or remux) `src` to `outPath` so it fits `DECODE_BUDGET` — the Pi has to decode this
   * in software (issue #180, [ADR 0040](../../../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)).
   * Only called when `needsNormalize` says the input is over budget.
   */
  normalize(src: string, outPath: string, info: VideoInfo): Promise<void>;
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

// What we'll *accept* from a human or a generator. Both are normalized to H.264 on ingest — the Pi 5
// decodes H.264 in software and won't reliably play HEVC in Chromium at all, so H.264 is the only
// thing that reaches the runtime (issue #180, ADR 0040). This comment used to read "H.265 for Pi 5",
// which had it exactly backwards; see backdrop-spec §4.
const ALLOWED_CODECS = new Set(["h264", "hevc"]);

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
 * What Backdrop's Pi can actually decode, and what we therefore encode to (issue #180,
 * [ADR 0040](../../../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)).
 *
 * **The Pi 5 has no hardware H.264 decoder** — VideoCore VII dropped the Pi 4's H.264 block and kept
 * only HEVC — so every visualizer frame is decoded on the CPU, inside Chromium, while it also
 * composites the page. The visualizers that shipped before this existed were 1080p30 **~20 Mbps**
 * with an AAC track, and they stuttered and tore on the display while playing perfectly in Curator's
 * preview (a workstation with a hardware decoder).
 *
 * `maxBitrateBps` (the accept ceiling) deliberately sits above `targetMaxrateBps` (what the encode
 * aims at): without that margin a file we just normalized could probe a hair over its own target and
 * get re-encoded on every ingest.
 */
export const DECODE_BUDGET = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 30,
  /** Accept ceiling — above this, normalize. */
  maxBitrateBps: 10_000_000,
  /** Encode target — `-maxrate` handed to libx264. */
  targetMaxrateBps: 8_000_000,
  /** 2s at 30fps. The as-shipped files used ~5.1s, which makes any dropped frame linger. */
  gopFrames: 60,
  crf: 21,
  /** Decode cost is independent of encode preset, and this runs in an upload request — so favour
   * encode speed. Measured: 110s of 1080p in 64s, vs 155s at `medium`, for the same bitrate. */
  preset: "veryfast",
  profile: "high",
  level: "4.0",
} as const;

/** Why a file is over budget. `[]` means it can go to the Pi as-is. */
export type BudgetViolation =
  "codec" | "resolution" | "fps" | "bitrate" | "audio";

/**
 * Which parts of `info` exceed `DECODE_BUDGET`. Pure, so the policy is unit-tested without shelling
 * out. Checks only what actually costs the decoder: codec, pixel count, frame rate, bitrate, and a
 * dead audio track. Profile/level are set on encode but not checked — Main vs High doesn't move
 * software-decode cost, so demanding it would buy a pointless re-encode.
 */
export function budgetViolations(info: VideoInfo): BudgetViolation[] {
  const v: BudgetViolation[] = [];
  if (info.codec !== "h264") v.push("codec");
  if (
    info.width > DECODE_BUDGET.maxWidth ||
    info.height > DECODE_BUDGET.maxHeight
  )
    v.push("resolution");
  // Tolerance so 29.97 reads as 30 rather than as an over-rate file.
  if (info.fps > DECODE_BUDGET.maxFps + 0.5) v.push("fps");
  if (info.bitRateBps <= 0 || info.bitRateBps > DECODE_BUDGET.maxBitrateBps)
    v.push("bitrate");
  if (info.hasAudio) v.push("audio");
  return v;
}

/** Does this file need re-encoding before it can go to the Pi? */
export function needsNormalize(info: VideoInfo): boolean {
  return budgetViolations(info).length > 0;
}

/**
 * ffmpeg argv that brings `src` inside `DECODE_BUDGET`. Exported so the encode policy is asserted
 * without shelling out (mirrors `buildConcatArgs`).
 *
 * When a muted audio track is the *only* violation the video stream is copied, not re-encoded — an
 * NLE export that already fits the budget shouldn't pay a full re-encode (and the generation loss)
 * just to drop a track the runtime never plays.
 */
export function buildNormalizeArgs(
  src: string,
  outPath: string,
  info: VideoInfo,
): string[] {
  const violations = budgetViolations(info);
  const videoIsFine =
    violations.length > 0 && violations.every((v) => v === "audio");

  const head = ["-y", "-i", src, "-map", "0:v:0", "-an"];
  // `-f mp4` is not optional here: the caller encodes to `{dest}.tmp-{uuid}` and renames on success,
  // so there is no `.mp4` extension for ffmpeg to infer the muxer from and it fails outright with
  // "Error initializing the muxer … Invalid argument". Pinning the container makes the argv
  // independent of whatever the caller names the file.
  const tail = ["-movflags", "+faststart", "-f", "mp4", outPath];

  if (videoIsFine) return [...head, "-c:v", "copy", ...tail];

  const filters: string[] = [];
  if (violations.includes("resolution"))
    filters.push(
      `scale=${DECODE_BUDGET.maxWidth}:${DECODE_BUDGET.maxHeight}:` +
        `force_original_aspect_ratio=decrease`,
      "setsar=1",
    );

  return [
    ...head,
    ...(filters.length ? ["-vf", filters.join(",")] : []),
    ...(violations.includes("fps") ? ["-r", String(DECODE_BUDGET.maxFps)] : []),
    "-c:v",
    "libx264",
    "-profile:v",
    DECODE_BUDGET.profile,
    "-level",
    DECODE_BUDGET.level,
    "-preset",
    DECODE_BUDGET.preset,
    "-crf",
    String(DECODE_BUDGET.crf),
    "-maxrate",
    String(DECODE_BUDGET.targetMaxrateBps),
    "-bufsize",
    String(DECODE_BUDGET.targetMaxrateBps * 2),
    "-g",
    String(DECODE_BUDGET.gopFrames),
    "-pix_fmt",
    "yuv420p",
    ...tail,
  ];
}

/**
 * Ingest a raw uploaded/incoming video into the store: probe + validate, bring it inside
 * `DECODE_BUDGET` (copying verbatim when it already fits), render a midpoint thumbnail, and return
 * the asset's visualizer section. On a validation failure nothing is written. Optionally removes the
 * source afterwards.
 *
 * The conformant-input fast path is what keeps the splice cheap: `buildConcatArgs` already encodes to
 * the budget, so a spliced loop lands here in-budget and is copied rather than encoded a second time.
 *
 * **The source may already _be_ the destination** — re-attaching a video that's still in
 * `visualizers/` from a previous attach ingests `visualizers/{id}.mp4` onto itself (issue #99). Both
 * file operations are skipped in that case: `copyFileSync` onto its own path is a no-op at best and an
 * `EBUSY` on Windows, and honouring `removeSrc` would delete the file the caller is attaching. The
 * probe/validate/normalize/thumbnail work still runs, so a hand-dropped file is checked as usual.
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
  const inPlace = resolve(args.srcPath) === resolve(dest);

  // Over budget ⇒ normalize (issue #180). Encode to a temp beside the destination and rename only on
  // a clean finish: a half-written mp4 that *looks* whole is worse than none, because Backdrop would
  // happily play it.
  let stored = info;
  if (needsNormalize(info)) {
    const tmp = `${dest}.tmp-${randomUUID()}`;
    try {
      await deps.prober.normalize(args.srcPath, tmp, info);
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      stored = await deps.prober.probe(dest);
    } catch {
      // Cosmetic only — `stored` stays the source's numbers. Not worth failing an otherwise-good
      // encode over a probe of the file we just wrote.
    }
  } else if (!inPlace) {
    copyFileSync(args.srcPath, dest);
  }

  mkdirSync(deps.paths.thumbnails, { recursive: true });
  const at = stored.durationSec > 0 ? stored.durationSec / 2 : 0;
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
  if (args.removeSrc && !inPlace) rmSync(args.srcPath, { force: true });

  const now = (deps.now ?? (() => new Date().toISOString()))();
  return {
    fileId: args.fileId,
    originalFilename: args.originalFilename,
    durationSec: Math.round(stored.durationSec),
    resolution: `${stored.width}x${stored.height}`,
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
// A normalize re-encodes one whole visualizer. Measured at `DECODE_BUDGET.preset`: 110s of 1080p in
// 64s, so ~0.6x realtime — this ceiling covers a ~15-minute source with room to spare.
const NORMALIZE_TIMEOUT_MS = 600_000;

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
      if (code === 0) return resolve(out);
      // The TAIL of stderr, not the head: ffmpeg opens with ~15 lines of version/configuration banner
      // and puts the actual cause last, so slicing from the front reported the banner every time and
      // nothing else. That turned a plain muxer error into an unexplained numeric exit code (#180).
      // Windows reports a negative errno as its unsigned wrap, so fold it back — `-22` beats
      // `4294967274` for anyone searching.
      const signed =
        code !== null && code > 2 ** 31 ? code - 2 ** 32 : (code ?? "null");
      reject(
        new VideoError(`${bin} exited ${signed}: ${err.trim().slice(-500)}`),
      );
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

  // Encoded to `DECODE_BUDGET` (issue #180) for the same reason a normalize is: the Pi decodes this in
  // software. Keeping the settings identical to `buildNormalizeArgs` is also what lets `ingestVideo`
  // copy the spliced result verbatim instead of encoding it a second time.
  return [
    "-y",
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-profile:v",
    DECODE_BUDGET.profile,
    "-level",
    DECODE_BUDGET.level,
    "-preset",
    DECODE_BUDGET.preset,
    "-crf",
    String(DECODE_BUDGET.crf),
    "-maxrate",
    String(DECODE_BUDGET.targetMaxrateBps),
    "-bufsize",
    String(DECODE_BUDGET.targetMaxrateBps * 2),
    "-g",
    String(DECODE_BUDGET.gopFrames),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

/**
 * Shrink `width`x`height` to fit inside `DECODE_BUDGET`, preserving aspect ratio; a frame already
 * inside it passes through untouched. Dimensions are forced even — H.264's 4:2:0 chroma requires it.
 */
export function fitWithinBudget(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    DECODE_BUDGET.maxWidth / width,
    DECODE_BUDGET.maxHeight / height,
  );
  if (scale >= 1) return { width, height };
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2));
  return { width: even(width), height: even(height) };
}

/** ffprobe reports frame rates as a rational string (`"30/1"`, `"30000/1001"`, `"0/0"` if unknown). */
export function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
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
      format?: { format_name?: string; duration?: string; bit_rate?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        bit_rate?: string;
        avg_frame_rate?: string;
        r_frame_rate?: string;
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
      // Some muxes omit the per-stream bitrate; the container's figure includes audio, which only
      // makes the budget check more conservative. 0 when neither is readable — read as over budget.
      bitRateBps: Math.round(
        Number(video.bit_rate ?? parsed.format?.bit_rate ?? 0) || 0,
      ),
      fps: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
    };
  },

  async normalize(src, outPath, info) {
    await run(
      FFMPEG,
      buildNormalizeArgs(src, outPath, info),
      NORMALIZE_TIMEOUT_MS,
    );
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
  // Never join *up* past what the Pi can decode (issue #180): a 4K clip set would otherwise produce a
  // 4K loop that `ingestVideo` immediately has to encode a second time to get back in budget.
  const fit = fitWithinBudget(width, height);
  const uniform = infos.every((i) => i.width === width && i.height === height);
  const clamped = fit.width !== width || fit.height !== height;
  const build: BuildConcatArgs = {};
  if (!uniform || opts.crossfade || clamped) build.size = fit;
  if (opts.crossfade)
    build.crossfade = {
      durationSec: opts.crossfade.durationSec,
      durations: infos.map((i) => i.durationSec),
    };
  return build;
}
