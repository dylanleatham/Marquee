import { describe, it, expect, vi } from "vitest";
import { CURATOR_URI_KINDS, type LibraryEntry } from "@marquee/contracts";
import { PlaybackController, type LibraryLookup } from "../src/controller.js";
import { FakeTimers, RecordingHub, tempMedia } from "./fakes.js";

/** A fixed lookup over a name→entry map. */
function lookup(entries: Record<string, LibraryEntry>): LibraryLookup {
  return { resolve: (uri) => entries[uri] };
}

const IDLE_MS = 90 * 60 * 1000;

function setup(
  entries: Record<string, LibraryEntry>,
  mediaDir: string,
  defaultVisualizerPath?: string,
) {
  const hub = new RecordingHub();
  const timers = new FakeTimers();
  const controller = new PlaybackController(lookup(entries), hub, {
    timers,
    idleTimeoutMs: IDLE_MS,
    mediaDir,
    ...(defaultVisualizerPath ? { defaultVisualizerPath } : {}),
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

  // Backdrop plays one video per album whatever object was scanned: a shelf card (ADR 0034) and a
  // demo tag (ADR 0058) show the same visualizer as the sleeve. Enumerated off the contract's kind
  // list so a new kind is covered here the moment it exists.
  it.each(CURATOR_URI_KINDS.filter((k) => k !== "album"))(
    "a %s scan plays the same album video as the sleeve",
    (kind) => {
      const { dir, paths } = tempMedia(["x.mp4"]);
      // Library is keyed by the album URI (as Curator syncs it) — no per-kind key.
      const { controller, hub } = setup(
        { "curator:album:2k7bxq9m": { filePath: paths["x.mp4"]! } },
        dir,
      );

      controller.play(`curator:${kind}:2k7bxq9m`);

      expect(hub.last()).toEqual({ type: "play", filePath: paths["x.mp4"] });
      expect(controller.status().state).toBe("playing");
      // Status keeps the actual scanned URI, even though lookup normalised to the album key.
      expect(controller.status().uri).toBe(`curator:${kind}:2k7bxq9m`);
      controller.dispose();
    },
  );

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

  it("logs a server-side warning when a scan can't be played (spec §8/§9)", () => {
    const { dir } = tempMedia([]);
    const hub = new RecordingHub();
    const warn = vi.fn();
    const controller = new PlaybackController(lookup({}), hub, {
      timers: new FakeTimers(),
      idleTimeoutMs: IDLE_MS,
      mediaDir: dir,
      logger: { warn },
    });
    controller.play("curator:album:missing");
    expect(warn).toHaveBeenCalledWith(
      { uri: "curator:album:missing" },
      expect.stringContaining("not in the library"),
    );
  });

  // --- The default visualizer (ADR 0073) --------------------------------------------------------
  // A record Curator knows about but hasn't finished plays a shared fallback clip instead of
  // nothing. The line the tests below hold is *which* silence gets covered: an entry that is present
  // and unfinished, never an entry that is absent — a scan nothing knows is how a mis-written
  // sticker announces itself, and the fallback must not swallow it.
  describe("default visualizer", () => {
    it("a record with no visualizer of its own plays the default", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller, hub, timers } = setup(
        { "curator:album:2k7bxq9m": { usesDefault: true } },
        dir,
        paths["default.mp4"],
      );

      controller.play("curator:album:2k7bxq9m");

      expect(hub.last()).toEqual({
        type: "play",
        filePath: paths["default.mp4"],
      });
      expect(controller.status().state).toBe("playing");
      // The scanned record, not the clip — the room is still that record's room.
      expect(controller.status().uri).toBe("curator:album:2k7bxq9m");
      expect(controller.status().usingDefault).toBe(true);
      expect(timers.activeAt(IDLE_MS)).toBe(1); // the safety net still arms
      controller.dispose();
    });

    it("a record whose own file never landed falls back to the default", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller, hub } = setup(
        { "curator:album:x": { filePath: `${dir}/never-synced.mp4` } },
        dir,
        paths["default.mp4"],
      );

      controller.play("curator:album:x");

      expect(hub.last()).toEqual({
        type: "play",
        filePath: paths["default.mp4"],
      });
      expect(controller.status().usingDefault).toBe(true);
      controller.dispose();
    });

    it("a filePath escaping the media dir falls back, and never plays the poisoned path", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller, hub } = setup(
        { "curator:album:evil": { filePath: "/etc/passwd" } },
        dir,
        paths["default.mp4"],
      );

      controller.play("curator:album:evil");

      expect(hub.last()).toEqual({
        type: "play",
        filePath: paths["default.mp4"],
      });
      expect(hub.commands).not.toContainEqual({
        type: "play",
        filePath: "/etc/passwd",
      });
      controller.dispose();
    });

    // The whole reason the marker exists. Without it Backdrop would have to treat every
    // unresolvable scan as an unfinished record, and the one indicator that catches a stray or
    // mis-written tag would be gone.
    it("an unknown URI still says 'not in library' — the default does not cover it", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller, hub } = setup({}, dir, paths["default.mp4"]);

      controller.play("curator:album:nosuchid");

      expect(controller.status().state).toBe("idle");
      expect(hub.last()).toMatchObject({
        type: "show-message",
        text: "video not in library",
      });
      expect(hub.commands.some((c) => c.type === "play")).toBe(false);
    });

    it("a card scan of an unfinished record plays the default too", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller, hub } = setup(
        { "curator:album:2k7bxq9m": { usesDefault: true } },
        dir,
        paths["default.mp4"],
      );

      controller.play("curator:card:2k7bxq9m");

      expect(hub.last()).toEqual({
        type: "play",
        filePath: paths["default.mp4"],
      });
      controller.dispose();
    });

    it("swapping from the default to a real visualizer clears usingDefault", () => {
      const { dir, paths } = tempMedia(["default.mp4", "a.mp4"]);
      const { controller } = setup(
        {
          "curator:album:unfinishd": { usesDefault: true },
          "curator:album:a": { filePath: paths["a.mp4"]! },
        },
        dir,
        paths["default.mp4"],
      );

      controller.play("curator:album:unfinishd");
      expect(controller.status().usingDefault).toBe(true);
      controller.play("curator:album:a");

      expect(controller.status().usingDefault).toBe(false);
      expect(controller.status().filePath).toBe(paths["a.mp4"]);
      controller.dispose();
    });

    it("stop clears usingDefault", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const { controller } = setup(
        { "curator:album:unfinishd": { usesDefault: true } },
        dir,
        paths["default.mp4"],
      );
      controller.play("curator:album:unfinishd");
      controller.stop();
      expect(controller.status().usingDefault).toBe(false);
    });

    // The clip is one file on the Pi, so it is one thing to forget — and forgetting it takes out
    // every unfinished record at once. It must say so rather than look like a dead display.
    it("no default clip on disk → stays put and says 'no visualizer yet'", () => {
      const { dir } = tempMedia([]); // configured, never synced
      const { controller, hub } = setup(
        { "curator:album:unfinishd": { usesDefault: true } },
        dir,
        `${dir}/default.mp4`,
      );

      controller.play("curator:album:unfinishd");

      expect(controller.status().state).toBe("idle");
      expect(hub.last()).toMatchObject({
        type: "show-message",
        text: "no visualizer yet",
      });
    });

    // Two absent files, two different jobs: attach a visualizer, versus re-run the sync that was
    // supposed to move one. The wording is what tells them apart from the sofa.
    it("a missing own-file with no default still says 'video file missing'", () => {
      const { dir } = tempMedia([]);
      const { controller, hub } = setup(
        { "curator:album:x": { filePath: `${dir}/never-synced.mp4` } },
        dir,
        `${dir}/default.mp4`,
      );

      controller.play("curator:album:x");

      expect(hub.last()).toMatchObject({
        type: "show-message",
        text: "video file missing",
      });
    });

    it("logs which record fell back and to what", () => {
      const { dir, paths } = tempMedia(["default.mp4"]);
      const hub = new RecordingHub();
      const warn = vi.fn();
      const controller = new PlaybackController(
        lookup({ "curator:album:unfinishd": { usesDefault: true } }),
        hub,
        {
          timers: new FakeTimers(),
          idleTimeoutMs: IDLE_MS,
          mediaDir: dir,
          defaultVisualizerPath: paths["default.mp4"]!,
          logger: { warn },
        },
      );

      controller.play("curator:album:unfinishd");

      expect(warn).toHaveBeenCalledWith(
        {
          uri: "curator:album:unfinishd",
          filePath: null,
          defaultVisualizer: paths["default.mp4"],
        },
        expect.stringContaining("playing the default"),
      );
      controller.dispose();
    });
  });

  it("handleScan routes start/stop to play/stop", () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const { controller } = setup(
      { "curator:album:x": { filePath: paths["x.mp4"]! } },
      dir,
    );
    controller.handleScan({
      event: "start",
      uri: "curator:album:x",
      tagUid: "04:A1",
      at: "t",
    });
    expect(controller.status().state).toBe("playing");
    controller.handleScan({ event: "stop", at: "t" });
    expect(controller.status().state).toBe("idle");
  });
});
