import { describe, it, expect } from "vitest";
import type { LibraryEntry } from "@marquee/contracts";
import { PlaybackController, type LibraryLookup } from "../src/controller.js";
import { FakeTimers, RecordingHub, tempMedia } from "./fakes.js";

/** A fixed lookup over a name→entry map. */
function lookup(entries: Record<string, LibraryEntry>): LibraryLookup {
  return { resolve: (uri) => entries[uri] };
}

const IDLE_MS = 90 * 60 * 1000;

function setup(entries: Record<string, LibraryEntry>, mediaDir: string) {
  const hub = new RecordingHub();
  const timers = new FakeTimers();
  const controller = new PlaybackController(lookup(entries), hub, {
    timers,
    idleTimeoutMs: IDLE_MS,
    mediaDir,
  });
  return { controller, hub, timers };
}

describe("PlaybackController", () => {
  it("play → broadcasts play, enters playing, arms the idle timeout", () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const { controller, hub, timers } = setup(
      { "curator:album:x": { filePath: paths["x.mp4"]! } },
      dir,
    );

    controller.play("curator:album:x");

    expect(hub.last()).toEqual({ type: "play", filePath: paths["x.mp4"] });
    expect(controller.status().state).toBe("playing");
    expect(controller.status().uri).toBe("curator:album:x");
    expect(timers.activeAt(IDLE_MS)).toBe(1);
    controller.dispose();
  });

  it("stop → broadcasts stop, returns to idle, clears the idle timeout", () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const { controller, hub, timers } = setup(
      { "curator:album:x": { filePath: paths["x.mp4"]! } },
      dir,
    );
    controller.play("curator:album:x");
    controller.stop();

    expect(hub.last()).toEqual({ type: "stop" });
    expect(controller.status().state).toBe("idle");
    expect(controller.status().uri).toBeNull();
    expect(timers.activeAt(IDLE_MS)).toBe(0); // safety-net timer cancelled
  });

  it("a swap re-arms a single idle timeout (no leak across scans)", () => {
    const { dir, paths } = tempMedia(["a.mp4", "b.mp4"]);
    const { controller, timers } = setup(
      {
        "curator:album:a": { filePath: paths["a.mp4"]! },
        "curator:album:b": { filePath: paths["b.mp4"]! },
      },
      dir,
    );
    controller.play("curator:album:a");
    controller.play("curator:album:b");
    expect(controller.status().filePath).toBe(paths["b.mp4"]);
    expect(timers.activeAt(IDLE_MS)).toBe(1); // exactly one live timer, not two
    controller.dispose();
  });

  it("idle timeout fires → fades to idle on its own (lost-stop safety net)", () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const { controller, hub, timers } = setup(
      { "curator:album:x": { filePath: paths["x.mp4"]! } },
      dir,
    );
    controller.play("curator:album:x");
    timers.fire(IDLE_MS);
    expect(controller.status().state).toBe("idle");
    expect(hub.last()).toEqual({ type: "stop" });
  });

  it("unknown URI → stays put, flashes 'not in library', never plays", () => {
    const { dir } = tempMedia([]);
    const { controller, hub } = setup({}, dir);
    controller.play("curator:album:missing");
    expect(controller.status().state).toBe("idle");
    expect(hub.last()).toMatchObject({
      type: "show-message",
      text: "video not in library",
    });
  });

  it("known URI but missing file → stays put, flashes 'video file missing'", () => {
    const { dir } = tempMedia([]); // entry points at a file that was never synced
    const { controller, hub } = setup(
      { "curator:album:x": { filePath: `${dir}/never-synced.mp4` } },
      dir,
    );
    controller.play("curator:album:x");
    expect(controller.status().state).toBe("idle");
    expect(hub.last()).toMatchObject({
      type: "show-message",
      text: "video file missing",
    });
  });

  it("rejects a filePath that escapes the media dir (poisoned library)", () => {
    const { dir } = tempMedia([]);
    const { controller, hub } = setup(
      { "curator:album:evil": { filePath: "/etc/passwd" } },
      dir,
    );
    controller.play("curator:album:evil");
    expect(controller.status().state).toBe("idle");
    expect(hub.last()).toMatchObject({
      type: "show-message",
      text: "video file missing",
    });
  });

  it("handleScan routes start/stop to play/stop", () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const { controller } = setup(
      { "curator:album:x": { filePath: paths["x.mp4"]! } },
      dir,
    );
    controller.handleScan({ event: "start", uri: "curator:album:x", at: "t" });
    expect(controller.status().state).toBe("playing");
    controller.handleScan({ event: "stop", at: "t" });
    expect(controller.status().state).toBe("idle");
  });
});
