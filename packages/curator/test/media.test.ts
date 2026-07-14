import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "../src/store/paths.js";
import {
  validateVideo,
  ingestVideo,
  VideoError,
  type VideoInfo,
} from "../src/media/video.js";
import {
  detectImage,
  imageSize,
  ingestCardArt,
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
