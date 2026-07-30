import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Paths } from "../src/store/paths.js";
import type { spawn, spawnSync } from "node:child_process";
import {
  validateVideo,
  ingestVideo,
  ffmpegAvailable,
  run,
  VideoError,
  type VideoInfo,
} from "../src/media/video.js";
import {
  detectImage,
  imageSize,
  ingestCardArt,
  ingestCardArtCandidate,
  ImageError,
} from "../src/media/images.js";
import { fakeProber, pngBytes, jpegBytes } from "./helpers.js";

const paths = () => new Paths(mkdtempSync(join(tmpdir(), "curator-media-")));
const h264: VideoInfo = {
  durationSec: 180,
  width: 1920,
  height: 1080,
  codec: "h264",
  container: "mov,mp4,m4a",
  bitRateBps: 7_300_000,
  fps: 30,
  hasAudio: false,
};

describe("validateVideo", () => {
  it("accepts H.264 and H.265 in an MP4 container", () => {
    expect(() => validateVideo(h264)).not.toThrow();
    expect(() => validateVideo({ ...h264, codec: "hevc" })).not.toThrow();
  });
  it("rejects a non-MP4 container and a disallowed codec", () => {
    expect(() =>
      validateVideo({ ...h264, container: "matroska,webm" }),
    ).toThrow(VideoError);
    expect(() => validateVideo({ ...h264, codec: "vp9" })).toThrow(
      /H.264 or H.265/,
    );
  });
});

describe("ingestVideo", () => {
  it("copies the video to visualizers/, writes a thumbnail, and returns the section", async () => {
    const p = paths();
    const src = join(p.incoming, "raw.mp4");
    // Stage a source file (ingest copies from it).
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(p.incoming, { recursive: true });
    writeFileSync(src, Buffer.from("VIDEOBYTES"));

    const vis = await ingestVideo(
      { prober: fakeProber(), paths: p, now: () => "2026-07-13T00:00:00.000Z" },
      {
        srcPath: src,
        fileId: "abcd1234",
        originalFilename: "raw.mp4",
        removeSrc: true,
      },
    );

    expect(vis).toMatchObject({
      fileId: "abcd1234",
      originalFilename: "raw.mp4",
      durationSec: 180,
      resolution: "1920x1080",
      loopStrategy: "loop",
    });
    expect(existsSync(p.visualizerFile("abcd1234"))).toBe(true);
    expect(existsSync(p.thumbnailFile("abcd1234"))).toBe(true);
    expect(existsSync(src)).toBe(false); // removeSrc
  });

  it("rejects a bad format before writing anything", async () => {
    const p = paths();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(p.incoming, { recursive: true });
    const src = join(p.incoming, "bad.webm");
    writeFileSync(src, Buffer.from("X"));
    await expect(
      ingestVideo(
        { prober: fakeProber({ container: "matroska,webm" }), paths: p },
        { srcPath: src, fileId: "abcd1234", originalFilename: "bad.webm" },
      ),
    ).rejects.toThrow(VideoError);
    expect(existsSync(p.visualizerFile("abcd1234"))).toBe(false);
  });
});

describe("ffmpegAvailable", () => {
  // The injected spawn stands in for spawnSync; only `status` and throwing behaviour matter.
  const fakeSpawn = (result: { status: number } | Error) =>
    ((..._args: unknown[]) => {
      if (result instanceof Error) throw result;
      return result;
    }) as unknown as typeof spawnSync;

  it("is true only when ffprobe exits 0", () => {
    expect(ffmpegAvailable(fakeSpawn({ status: 0 }))).toBe(true);
    expect(ffmpegAvailable(fakeSpawn({ status: 1 }))).toBe(false);
  });

  it("reports false (not throw) when the binary can't be spawned at all", () => {
    expect(ffmpegAvailable(fakeSpawn(new Error("ENOENT")))).toBe(false);
  });

  it("caps the probe with a timeout so a hung ffprobe can't block the event loop", () => {
    let opts: { timeout?: number } | undefined;
    const capture = ((
      _bin: string,
      _args: string[],
      o: { timeout?: number },
    ) => {
      opts = o;
      return { status: 0 };
    }) as unknown as typeof spawnSync;
    ffmpegAvailable(capture);
    expect(opts?.timeout).toBeGreaterThan(0);
  });
});

describe("run (ffmpeg wrapper) — timeout", () => {
  // A fake child process (EventEmitter) so the timeout path runs without shelling out.
  const fakeChild = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // SIGKILL → the OS would fire "close"; model that so run()'s handler resolves the promise.
    child.kill = vi.fn((_sig: string) => child.emit("close", null));
    return child;
  };
  const spawnReturning = (child: EventEmitter) =>
    (() => child) as unknown as typeof spawn;

  it("kills a stuck process past its budget and rejects with a timeout error", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const p = run("ffmpeg", ["-x"], 1000, spawnReturning(child));
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("resolves stdout on a clean exit (timer cleared, no kill)", async () => {
    const child = fakeChild();
    const p = run("ffprobe", ["-x"], 1000, spawnReturning(child));
    child.stdout.emit("data", "OUT");
    child.emit("close", 0);
    expect(await p).toBe("OUT");
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("detectImage + imageSize", () => {
  it("sniffs PNG and JPEG, rejects other bytes", () => {
    expect(detectImage(pngBytes())).toBe("png");
    expect(detectImage(jpegBytes())).toBe("jpg");
    expect(detectImage(Buffer.from("not an image"))).toBeNull();
  });
  it("reads PNG and JPEG dimensions from the header", () => {
    expect(imageSize(pngBytes(1050, 600), "png")).toEqual({
      width: 1050,
      height: 600,
    });
    expect(imageSize(jpegBytes(600, 1050), "jpg")).toEqual({
      width: 600,
      height: 1050,
    });
  });
});

describe("ingestCardArt", () => {
  it("stores the image and records extension + orientation", () => {
    const p = paths();
    const section = ingestCardArt(
      { paths: p, now: () => "2026-07-13T00:00:00.000Z" },
      {
        buffer: pngBytes(1050, 600),
        fileId: "abcd1234",
        originalFilename: "card.png",
      },
    );
    expect(section).toMatchObject({
      fileId: "abcd1234",
      ext: "png",
      resolution: "1050x600",
      orientation: "landscape",
    });
    const stored = p.cardArtFile("abcd1234", "png");
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).length).toBeGreaterThan(0);
  });
  it("marks a taller-than-wide image as portrait and rejects non-images", () => {
    const p = paths();
    expect(
      ingestCardArt(
        { paths: p },
        {
          buffer: jpegBytes(600, 1050),
          fileId: "abcd1234",
          originalFilename: "c.jpg",
        },
      ).orientation,
    ).toBe("portrait");
    expect(() =>
      ingestCardArt(
        { paths: p },
        {
          buffer: Buffer.from("nope"),
          fileId: "abcd1234",
          originalFilename: "x.txt",
        },
      ),
    ).toThrow(ImageError);
  });
});

describe("ingestCardArtCandidate", () => {
  it("stores at the indexed key and carries the nudge + size", () => {
    const p = paths();
    const cand = ingestCardArtCandidate(
      { paths: p, now: () => "2026-07-18T00:00:00.000Z" },
      {
        buffer: pngBytes(1050, 600),
        curatorId: "abcd1234",
        index: 3,
        nudge: "cover motifs",
      },
    );
    expect(cand).toMatchObject({
      index: 3,
      fileId: "abcd1234-c3",
      ext: "png",
      resolution: "1050x600",
      orientation: "landscape",
      nudge: "cover motifs",
    });
    expect(existsSync(p.cardArtFile("abcd1234-c3", "png"))).toBe(true);
  });
  it("rejects non-image bytes (the failure mode generateCardArtSet must isolate)", () => {
    const p = paths();
    expect(() =>
      ingestCardArtCandidate(
        { paths: p },
        {
          buffer: Buffer.from("NOT-AN-IMAGE"),
          curatorId: "abcd1234",
          index: 0,
        },
      ),
    ).toThrow(ImageError);
  });
});
