import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import * as actions from "../src/albums/actions.js";
import { type ActionDeps } from "../src/albums/actions.js";
import { ValidationError } from "../src/albums/add-manual.js";
import { TransitionError, type VideoClip } from "../src/albums/asset.js";
import {
  buildConcatArgs,
  resolveConcatBuild,
  type VideoProber,
  type VideoInfo,
  type ConcatOptions,
} from "../src/media/video.js";
import { makeAsset, fakeProber } from "./helpers.js";

const now = () => "2026-07-21T00:00:00.000Z";
const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-sp-")));

/** An album at awaiting_review with `n` generated clips + their files on disk. */
function seedClips(s: AssetStore, id = "aaaa1111", n = 3): string {
  const asset = makeAsset(id, "Purple Rain", "Prince");
  const clips: VideoClip[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    fileId: `${id}-v${i}`,
    nudge: `motion ${i}`,
    generatedAt: now(),
  }));
  asset.videoClips = clips;
  s.save(asset);
  mkdirSync(s.paths.visualizers, { recursive: true });
  for (const c of clips)
    writeFileSync(s.paths.visualizerFile(c.fileId), Buffer.from(c.fileId));
  return id;
}

/** A prober that records the files + options it was asked to concat (order/selection/crossfade). */
function recordingProber(): VideoProber & {
  joined: string[][];
  opts: (ConcatOptions | undefined)[];
} {
  const base = fakeProber();
  const joined: string[][] = [];
  const opts: (ConcatOptions | undefined)[] = [];
  return {
    ...base,
    joined,
    opts,
    concat: async (files, outPath, o) => {
      joined.push([...files]);
      opts.push(o);
      return base.concat(files, outPath, o);
    },
  };
}

const deps = (
  s: AssetStore,
  prober: VideoProber = fakeProber(),
): ActionDeps => ({
  store: s,
  prober,
  now,
});

describe("buildConcatArgs", () => {
  it("re-encodes to H.264 video-only with one input per file", () => {
    const args = buildConcatArgs(["/a.mp4", "/b.mp4"], "/out.mp4");
    expect(args).toContain("-i");
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args).toContain("libx264");
    expect(args).toContain("[0:v][1:v]concat=n=2:v=1:a=0[out]");
    expect(args[args.length - 1]).toBe("/out.mp4");
  });

  // Issue #180: the splice used to re-encode at libx264's bare defaults — no bitrate ceiling — which
  // is how ~20 Mbps loops reached a Pi that decodes H.264 in software.
  it("encodes the spliced loop inside the decode budget", () => {
    const args = buildConcatArgs(["/a.mp4", "/b.mp4"], "/out.mp4");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("8000000");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("high");
    expect(args[args.indexOf("-g") + 1]).toBe("60");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
  });

  // Issue #56: mismatched clip dimensions are scaled-to-fit + padded to a common frame before the
  // join, so a differing set doesn't fail or corrupt.
  it("normalizes every input to a common frame when a size is given", () => {
    const args = buildConcatArgs(["/a.mp4", "/b.mp4"], "/out.mp4", {
      size: { width: 1920, height: 1080 },
    });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain(
      "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]",
    );
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[out]");
  });

  // Issue #56: crossfade the seams with xfade. Each transition's offset accounts for the timeline
  // shortening by the crossfade duration at every prior seam.
  it("builds an xfade chain with cumulative offsets for a crossfade", () => {
    const args = buildConcatArgs(["/a.mp4", "/b.mp4", "/c.mp4"], "/out.mp4", {
      size: { width: 1280, height: 720 },
      crossfade: { durationSec: 0.5, durations: [8, 8, 8] },
    });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    // First seam at 8 − 0.5 = 7.5; second at (8 + 8 − 0.5) − 0.5 = 15.
    expect(filter).toContain(
      "[v0][v1]xfade=transition=fade:duration=0.5:offset=7.500[x1]",
    );
    expect(filter).toContain(
      "[x1][v2]xfade=transition=fade:duration=0.5:offset=15.000[out]",
    );
    expect(filter).not.toContain("concat=");
  });
});

describe("resolveConcatBuild (issue #56)", () => {
  const info = (width: number, height: number, durationSec = 8): VideoInfo => ({
    width,
    height,
    durationSec,
    codec: "h264",
    container: "mp4",
    bitRateBps: 7_300_000,
    fps: 30,
    hasAudio: false,
  });

  it("adds no normalization for same-size clips with no crossfade (keeps the minimal graph)", () => {
    const build = resolveConcatBuild([info(1920, 1080), info(1920, 1080)]);
    expect(build.size).toBeUndefined();
    expect(build.crossfade).toBeUndefined();
  });

  it("normalizes to the largest frame when clips differ in size", () => {
    const build = resolveConcatBuild([info(1920, 1080), info(1280, 720)]);
    expect(build.size).toEqual({ width: 1920, height: 1080 });
  });

  it("clamps an oversize clip set down to the decode budget (issue #180)", () => {
    // 4K clips must not join into a 4K loop — the Pi decodes this in software, and ingest would
    // otherwise have to re-encode the result straight back down.
    const build = resolveConcatBuild([info(3840, 2160), info(3840, 2160)]);
    expect(build.size).toEqual({ width: 1920, height: 1080 });
  });

  it("normalizes and carries per-clip durations when a crossfade is requested", () => {
    const build = resolveConcatBuild(
      [info(1280, 720, 8), info(1280, 720, 10)],
      { crossfade: { durationSec: 0.5 } },
    );
    expect(build.size).toEqual({ width: 1280, height: 720 });
    expect(build.crossfade).toEqual({ durationSec: 0.5, durations: [8, 10] });
  });
});

describe("spliceVisualizer", () => {
  it("joins all clips in index order by default and attaches the result", async () => {
    const s = store();
    const id = seedClips(s, "aaaa1111", 3);
    const prober = recordingProber();

    const asset = await actions.spliceVisualizer(deps(s, prober), id);

    // All three clip files, in index order, were concatenated.
    expect(prober.joined).toHaveLength(1);
    expect(prober.joined[0]).toEqual([
      s.paths.visualizerFile("aaaa1111-v0"),
      s.paths.visualizerFile("aaaa1111-v1"),
      s.paths.visualizerFile("aaaa1111-v2"),
    ]);
    // The spliced loop is attached as the single visualizer + the album advances to preview.
    expect(asset.visualizer?.fileId).toBe(id);
    expect(asset.visualizer?.originalFilename).toBe("spliced-loop.mp4");
    expect(asset.roadie.state).toBe("awaiting_preview");
    expect(existsSync(s.paths.visualizerFile(id))).toBe(true);
    // The temp splice file is cleaned up (not left in /incoming/).
    expect(
      existsSync(s.paths.incoming) ? readdirSync(s.paths.incoming) : [],
    ).toEqual([]);
  });

  it("respects a reordered/deselected subset", async () => {
    const s = store();
    const id = seedClips(s, "bbbb2222", 3);
    const prober = recordingProber();

    await actions.spliceVisualizer(deps(s, prober), id, [2, 0]);

    expect(prober.joined[0]).toEqual([
      s.paths.visualizerFile("bbbb2222-v2"),
      s.paths.visualizerFile("bbbb2222-v0"),
    ]);
  });

  it("passes a plain concat by default and threads a crossfade option when asked (issue #56)", async () => {
    const s = store();
    const id = seedClips(s, "cccc7777", 3);
    const prober = recordingProber();

    await actions.spliceVisualizer(deps(s, prober), id);
    expect(prober.opts[0]?.crossfade).toBeUndefined();

    // Re-seed (the first splice advanced the album out of the attachable window).
    const id2 = seedClips(s, "dddd8888", 3);
    await actions.spliceVisualizer(deps(s, prober), id2, undefined, {
      crossfade: { durationSec: 0.5 },
    });
    expect(prober.opts[1]?.crossfade).toEqual({ durationSec: 0.5 });
  });

  it("rejects an album with no generated clips", async () => {
    const s = store();
    const asset = makeAsset("cccc3333");
    s.save(asset);
    await expect(
      actions.spliceVisualizer(deps(s), "cccc3333"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an order referencing a nonexistent clip", async () => {
    const s = store();
    const id = seedClips(s, "dddd4444", 2);
    await expect(actions.spliceVisualizer(deps(s), id, [0, 9])).rejects.toThrow(
      /clip 9 does not exist/,
    );
  });

  it("rejects a duplicate clip in the order", async () => {
    const s = store();
    const id = seedClips(s, "eeee5555", 2);
    await expect(actions.spliceVisualizer(deps(s), id, [0, 0])).rejects.toThrow(
      /listed twice/,
    );
  });

  it("won't splice once the album is past the attachable window", async () => {
    const s = store();
    const id = seedClips(s, "ffff6666", 2);
    const asset = s.read(id)!;
    asset.roadie.state = "verified";
    s.save(asset);
    await expect(actions.spliceVisualizer(deps(s), id)).rejects.toBeInstanceOf(
      TransitionError,
    );
  });
});
