import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PromptBlock, VideoSection } from "./workflow";
import type { AlbumAsset, DraftedPrompt, RoadieState } from "../api";

afterEach(cleanup);

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
  it("offers 'Mark copied' only when allowed, and routes actions through run", () => {
    const run = vi.fn();
    const { rerender } = render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={prompt}
        canMarkCopied
        run={run}
      />,
    );
    fireEvent.click(screen.getByText("Mark copied →"));
    expect(run).toHaveBeenCalledTimes(1);

    // Changing the template also runs an action (redraft).
    fireEvent.change(screen.getByLabelText("prompt template"), {
      target: { value: "psychedelic" },
    });
    expect(run).toHaveBeenCalledTimes(2);

    rerender(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={prompt}
        canMarkCopied={false}
        run={run}
      />,
    );
    expect(screen.queryByText("Mark copied →")).toBeNull();
  });
});

describe("VideoSection", () => {
  it("disables the drop zone until the album is awaiting_video", () => {
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={albumAt("awaiting_review")}
        run={vi.fn()}
      />,
    );
    expect(screen.getByText(/Copy the video prompt above first/)).toBeTruthy();

    cleanup();
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={albumAt("awaiting_video")}
        run={vi.fn()}
      />,
    );
    expect(screen.getByText(/Drop an H\.264 MP4/)).toBeTruthy();
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
