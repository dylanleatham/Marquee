import { describe, it, expect } from "vitest";
import { albumUri, buildLibraryEntry } from "../src/backdrop/projection.js";
import { loadConfig } from "../src/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsset } from "./helpers.js";
import type { AlbumAsset } from "../src/albums/asset.js";

const withVideo = (
  id: string,
  over: Partial<AlbumAsset["visualizer"]> = {},
) => {
  const a = makeAsset(id);
  a.visualizer = {
    fileId: id,
    originalFilename: "clip.mp4",
    durationSec: 180,
    loopStrategy: "loop",
    attachedAt: "2026-07-11T00:00:00.000Z",
    ...over,
  };
  return a;
};

describe("backdrop projection", () => {
  it("builds the scan URI from the curatorId", () => {
    expect(albumUri("abc12345")).toBe("curator:album:abc12345");
  });

  it("maps an album with a visualizer to a library entry under Backdrop's media dir", () => {
    const entry = buildLibraryEntry(
      withVideo("abc12345"),
      "/srv/marquee/visualizers",
    );
    expect(entry).toEqual({
      uri: "curator:album:abc12345",
      filePath: "/srv/marquee/visualizers/abc12345.mp4",
      durationSec: 180,
    });
  });

  /**
   * ADR 0073. This used to return `null`, which meant Backdrop was never told the record existed —
   * so a scan of an unfinished record and a scan of a stray NTAG were indistinguishable: both
   * answered `video not in library` and left the display on whatever was there before. Naming the
   * record is what lets Backdrop play a default clip for one that is genuinely ours.
   */
  it("projects an album with no video as a usesDefault entry, not as nothing", () => {
    expect(buildLibraryEntry(makeAsset("novideo1"), "/srv/m")).toEqual({
      uri: "curator:album:novideo1",
      usesDefault: true,
    });
  });

  it("never names a filePath for an album with no video", () => {
    const entry = buildLibraryEntry(makeAsset("novideo2"), "/srv/m");
    expect("filePath" in entry).toBe(false);
  });

  it("emits a POSIX filePath even from a Windows-style media dir", () => {
    const entry = buildLibraryEntry(
      withVideo("winpath1"),
      "C:\\Users\\pi\\marquee\\visualizers",
    );
    expect(entry!.filePath).toBe(
      "C:/Users/pi/marquee/visualizers/winpath1.mp4",
    );
    expect(entry!.filePath).not.toContain("\\");
  });

  it("omits durationSec when the visualizer has none", () => {
    const a = withVideo("nodur123");
    delete a.visualizer!.durationSec;
    const entry = buildLibraryEntry(a, "/m");
    expect(entry).toEqual({
      uri: "curator:album:nodur123",
      filePath: "/m/nodur123.mp4",
    });
    expect("durationSec" in entry!).toBe(false);
  });

  /**
   * Issue #166, end to end. The defect lived in config resolution and only became visible in the
   * projection's output, so neither layer's own tests could catch it — this one spans both, using
   * the real `loadConfig` rather than a hand-written media dir.
   *
   * The property that matters to Backdrop: the filePath must sit under the media dir it was
   * configured with, because Backdrop refuses to load anything outside it (backdrop-spec §5).
   */
  it("produces a filePath under the configured remote media dir (config → projection)", () => {
    const mediaDir = "/home/pi/marquee-data/media/visualizers";
    // Drive the real resolution path — an `override` would bypass the very code under test.
    const saved = { ...process.env };
    process.env.CURATOR_CONFIG = join(tmpdir(), "no-such-curator-config.toml");
    process.env.BACKDROP_URL = "http://pi:4740";
    process.env.BACKDROP_MEDIA_DIR = mediaDir;
    delete process.env.BACKDROP_SYNC_MEDIA_LOCALLY;

    try {
      const config = loadConfig();
      const entry = buildLibraryEntry(
        withVideo("abc12345"),
        config.backdrop!.mediaDir,
      );

      expect(entry!.filePath).toBe(`${mediaDir}/abc12345.mp4`);
      expect(entry!.filePath.startsWith(mediaDir)).toBe(true);
      expect(entry!.filePath).not.toMatch(/^[A-Za-z]:/);
    } finally {
      process.env = saved;
    }
  });
});
