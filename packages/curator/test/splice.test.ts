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
  type VideoProber,
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

/** A prober that records the files it was asked to concat (for asserting order/selection). */
function recordingProber(): VideoProber & { joined: string[][] } {
  const base = fakeProber();
  const joined: string[][] = [];
  return {
    ...base,
    joined,
    concat: async (files, outPath) => {
      joined.push([...files]);
      return base.concat(files, outPath);
    },
  };
}

const deps = (s: AssetStore, prober: VideoProber = fakeProber()): ActionDeps => ({
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
    expect(existsSync(s.paths.incoming) ? readdirSync(s.paths.incoming) : []).toEqual([]);
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
    await expect(
      actions.spliceVisualizer(deps(s), id, [0, 9]),
    ).rejects.toThrow(/clip 9 does not exist/);
  });

  it("rejects a duplicate clip in the order", async () => {
    const s = store();
    const id = seedClips(s, "eeee5555", 2);
    await expect(
      actions.spliceVisualizer(deps(s), id, [0, 0]),
    ).rejects.toThrow(/listed twice/);
  });

  it("won't splice once the album is past the attachable window", async () => {
    const s = store();
    const id = seedClips(s, "ffff6666", 2);
    const asset = s.read(id)!;
    asset.roadie.state = "verified";
    s.save(asset);
    await expect(
      actions.spliceVisualizer(deps(s), id),
    ).rejects.toBeInstanceOf(TransitionError);
  });
});
