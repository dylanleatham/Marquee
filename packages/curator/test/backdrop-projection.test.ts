import { describe, it, expect } from "vitest";
import { albumUri, buildLibraryEntry } from "../src/backdrop/projection.js";
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

  it("returns null when no video is attached (nothing for Backdrop to play)", () => {
    expect(buildLibraryEntry(makeAsset("noVideo1"), "/srv/m")).toBeNull();
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
});
