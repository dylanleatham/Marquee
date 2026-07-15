import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { PromptBlock, VideoSection } from "./workflow";
import type { AlbumAsset, DraftedPrompt, RoadieState } from "../api";

afterEach(cleanup);

const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

const prompt: DraftedPrompt = {
  text: "draft text",
  template: "abstract_flow",
  generatedAt: "2026-07-13T00:00:00Z",
};

const albumAt = (
  state: RoadieState,
  extra: Partial<AlbumAsset> = {},
): AlbumAsset =>
  ({
    curatorId: "abcd1234",
    createdAt: "2026-07-13T00:00:00Z",
    metadata: { name: "X", artist: "Y", source: "manual" },
    roadie: {
      state,
      subState: null,
      flags: {
        palette_insufficient: false,
        album_not_on_spotify: false,
        art_override_active: false,
      },
      history: [],
      lastError: null,
      retryCount: 0,
    },
    status: { highLevel: state, next: null, issues: [] },
    ...extra,
  }) as AlbumAsset;

describe("PromptBlock", () => {
  // Issue #11 / ADR 0005: copying the prompt *is* the signal. A second "Mark copied" click was
  // pure ceremony — the server decides what a copy means per type (video at review advances the
  // album; card art is bookkeeping), so the button records the copy for both.
  it.each(["video", "cardArt"] as const)(
    "copies and records the copy in one click (%s), with no separate button",
    async (type) => {
      const run = vi.fn();
      render(
        <PromptBlock
          curatorId="abcd1234"
          type={type}
          prompt={prompt}
          run={run}
        />,
      );
      expect(screen.queryByText("Mark copied →")).toBeNull();

      fireEvent.click(screen.getByText("Copy prompt"));
      expect(writeText).toHaveBeenCalledWith("draft text");
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    },
  );

  // The copy is now what advances the album, so a blocked clipboard (denied permission, document
  // not focused) must not strand it at review — the text is on screen to take by hand regardless.
  it("still records the copy when the clipboard is blocked", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const run = vi.fn();
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={prompt}
        run={run}
      />,
    );
    fireEvent.click(screen.getByText("Copy prompt"));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("routes a template change through run (redraft)", () => {
    const run = vi.fn();
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={prompt}
        run={run}
      />,
    );
    fireEvent.change(screen.getByLabelText("prompt template"), {
      target: { value: "psychedelic" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("VideoSection", () => {
  // Issue #11: if you already have the video, you shouldn't have to touch the prompt first.
  it("offers the drop zone from awaiting_review onward", () => {
    for (const state of ["awaiting_review", "awaiting_video"] as const) {
      render(
        <VideoSection
          curatorId="abcd1234"
          asset={albumAt(state)}
          run={vi.fn()}
        />,
      );
      expect(screen.getByText(/Drop an H\.264 MP4/)).toBeTruthy();
      cleanup();
    }
  });

  it("keeps the drop zone shut while Roadie is still working", () => {
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={albumAt("generating_palette")}
        run={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Drop an H\.264 MP4/)).toBeNull();
  });

  it("shows the player + detach once a video is attached", () => {
    const asset = albumAt("awaiting_preview", {
      visualizer: {
        fileId: "abcd1234",
        originalFilename: "clip.mp4",
        resolution: "1920x1080",
        loopStrategy: "loop",
      },
    });
    const { container } = render(
      <VideoSection curatorId="abcd1234" asset={asset} run={vi.fn()} />,
    );
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "/api/albums/abcd1234/video",
    );
    expect(screen.getByText("Detach")).toBeTruthy();
  });
});
