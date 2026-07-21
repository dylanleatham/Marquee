import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { PromptBlock, VideoSection, CardArtSection } from "./workflow";
import {
  api,
  type AlbumAsset,
  type DraftedPrompt,
  type GenerationJob,
  type JobKind,
  type RoadieState,
} from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A terminal (done) job — lets a generate-click assert the POST without the hook then polling. */
const doneJob = (kind: JobKind): GenerationJob => ({
  id: "job-1",
  kind,
  curatorId: "abcd1234",
  status: "done",
  progress: { done: 1, total: 1 },
  createdAt: "2026-07-21T00:00:00Z",
  updatedAt: "2026-07-21T00:00:00Z",
});

const writeText = vi.fn();
beforeEach(() => {
  // Re-apply the resolved value each test: afterEach's restoreAllMocks (for the api spies) also
  // resets this fn's implementation.
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

const prompt: DraftedPrompt = {
  variants: [{ text: "draft text", nudge: "abstract_flow" }],
  selectedIndex: 0,
  generator: "template",
  template: "abstract_flow",
  generatedAt: "2026-07-13T00:00:00Z",
};

/** A grounded, multi-variant LLM draft (for the variant-selection tests). */
const aiPrompt: DraftedPrompt = {
  variants: [
    { text: "first variant text", nudge: "cover motifs" },
    { text: "second variant text", nudge: "atmospheric shimmer" },
  ],
  selectedIndex: 0,
  generator: "gemini",
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

  it("shows the active variant text and offers a chip per variant (LLM draft)", () => {
    const run = vi.fn();
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={aiPrompt}
        run={run}
      />,
    );
    // Active variant (index 0) is shown; the AI-provenance badge is present.
    expect(screen.getByText("first variant text")).toBeTruthy();
    expect(screen.getByText(/AI · grounded/)).toBeTruthy();
    // Selecting the second variant routes through run.
    fireEvent.click(screen.getByText(/atmospheric shimmer/));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("regenerates with AI through run", () => {
    const run = vi.fn();
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={prompt}
        run={run}
      />,
    );
    fireEvent.click(screen.getByText("Regenerate with AI"));
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

describe("VideoSection — clip generation", () => {
  const withVideoPrompt = (extra: Partial<AlbumAsset> = {}) =>
    albumAt("awaiting_review", {
      artwork: { resolvedPath: "media/artwork/abcd1234.jpg", contentHash: "x" },
      promptDrafts: {
        video: {
          variants: [{ text: "vp", nudge: "drift" }],
          selectedIndex: 0,
          generator: "gemini",
          generatedAt: "2026-07-18T00:00:00Z",
        },
      },
      ...extra,
    });

  it("offers Generate clips when enabled and a video prompt + cover art exist", async () => {
    // Generation is a background job (issue #30): the button POSTs and the hook polls — assert the
    // POST fires. albumJobs is stubbed so the mount re-attach finds nothing running.
    const gen = vi
      .spyOn(api, "generateVideoSet")
      .mockResolvedValue(doneJob("video"));
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={withVideoPrompt()}
        run={vi.fn()}
        canGenerate
      />,
    );
    fireEvent.click(screen.getByText(/Generate clips with AI/));
    await waitFor(() => expect(gen).toHaveBeenCalledTimes(1));
  });

  it("hides Generate clips when generation is off (the opt-in default)", () => {
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={withVideoPrompt()}
        run={vi.fn()}
        canGenerate={false}
      />,
    );
    expect(screen.queryByText(/Generate clips with AI/)).toBeNull();
  });

  it("renders a clip gallery with per-clip download links", () => {
    const asset = withVideoPrompt({
      videoClips: [
        {
          index: 0,
          fileId: "abcd1234-v0",
          nudge: "drift",
          durationSec: 8,
          generatedAt: "x",
        },
        {
          index: 1,
          fileId: "abcd1234-v1",
          nudge: "pulse",
          durationSec: 8,
          generatedAt: "x",
        },
      ],
    });
    render(<VideoSection curatorId="abcd1234" asset={asset} run={vi.fn()} />);
    const vids = document.querySelectorAll(".video__clip-vid");
    expect(vids).toHaveLength(2);
    expect(vids[0]!.getAttribute("src")).toBe(
      "/api/albums/abcd1234/video/clip/0",
    );
    const downloads = screen.getAllByText("Download");
    expect(downloads).toHaveLength(2);
    expect(downloads[0]!.getAttribute("href")).toBe(
      "/api/albums/abcd1234/video/clip/0?download=1",
    );
  });

  it("does not offer Generate clips without cover art (even when enabled)", () => {
    const asset = withVideoPrompt({ artwork: undefined });
    render(
      <VideoSection
        curatorId="abcd1234"
        asset={asset}
        run={vi.fn()}
        canGenerate
      />,
    );
    expect(screen.queryByText(/Generate clips with AI/)).toBeNull();
  });
});

describe("CardArtSection", () => {
  const withCardPrompt = (extra: Partial<AlbumAsset> = {}) =>
    albumAt("awaiting_review", {
      promptDrafts: {
        cardArt: {
          variants: [{ text: "card prompt", nudge: "cover" }],
          selectedIndex: 0,
          generator: "gemini",
          generatedAt: "2026-07-18T00:00:00Z",
        },
      },
      ...extra,
    });

  it("offers Generate options when enabled and a card-art prompt exists", async () => {
    const gen = vi
      .spyOn(api, "generateCardArtSet")
      .mockResolvedValue(doneJob("cardArt"));
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    render(
      <CardArtSection
        curatorId="abcd1234"
        asset={withCardPrompt()}
        run={vi.fn()}
        canGenerate
      />,
    );
    fireEvent.click(screen.getByText(/Generate options with AI/));
    await waitFor(() => expect(gen).toHaveBeenCalledTimes(1));
  });

  it("renders a clickable gallery of candidates and selects one", () => {
    const run = vi.fn();
    const asset = withCardPrompt({
      cardArtCandidates: [
        {
          index: 0,
          fileId: "abcd1234-c0",
          ext: "png",
          nudge: "motif",
          generatedAt: "x",
        },
        {
          index: 1,
          fileId: "abcd1234-c1",
          ext: "png",
          nudge: "shimmer",
          generatedAt: "x",
        },
      ],
    });
    render(<CardArtSection curatorId="abcd1234" asset={asset} run={run} />);
    // A thumbnail per candidate, served from the candidate URL.
    const imgs = document.querySelectorAll(".cardart__candidate img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe(
      "/api/albums/abcd1234/card-art/candidate/0",
    );
    // Clicking a candidate routes the select through run.
    fireEvent.click(screen.getByText("shimmer"));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
