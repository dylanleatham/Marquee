import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  PromptBlock,
  VideoSection,
  CardArtSection,
  TagWriteSection,
} from "./workflow";
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
  // Both video and card art surface every prompt with its own per-prompt "Copy" (ADR 0021/0022).
  // Either way the click records the copy (no separate button).
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

      fireEvent.click(screen.getByText("Copy"));
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
    fireEvent.click(screen.getByText("Copy"));
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

  it("surfaces every video variant in full, each copyable (LLM draft)", () => {
    const run = vi.fn();
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={aiPrompt}
        run={run}
      />,
    );
    // Both variant texts are shown (no pick-one hiding); the AI-provenance badge is present.
    expect(screen.getByText("first variant text")).toBeTruthy();
    expect(screen.getByText("second variant text")).toBeTruthy();
    expect(screen.getByText(/AI · grounded/)).toBeTruthy();
    expect(screen.getByText(/atmospheric shimmer/)).toBeTruthy();
    // One Copy button per variant; clicking the second copies its text.
    const copies = screen.getAllByText("Copy");
    expect(copies).toHaveLength(2);
    fireEvent.click(copies[1]!);
    expect(writeText).toHaveBeenCalledWith("second variant text");
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

  // Issue #62: the slow AI redraft must show it's working — spinner + "Regenerating…" + disabled —
  // until the action settles, so it can't be fired twice.
  it("shows a Regenerating… affordance while the AI redraft is in flight", async () => {
    let release!: () => void;
    const run = vi.fn(
      () => new Promise<void>((r) => (release = r)),
    ) as unknown as (fn: () => Promise<unknown>) => Promise<void>;
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={prompt}
        run={run}
      />,
    );
    fireEvent.click(screen.getByText("Regenerate with AI"));
    const btn = await screen.findByText("Regenerating…");
    expect(btn.closest("button")!.disabled).toBe(true);
    release();
    await waitFor(() =>
      expect(screen.getByText("Regenerate with AI")).toBeTruthy(),
    );
  });
});

// The card-art prompt block surfaces all five prompts, each individually copyable and (when API
// generation is enabled) individually generatable against Nano Banana (ADR 0021).
describe("PromptBlock — card art prompt set (ADR 0021)", () => {
  const fivePrompts: DraftedPrompt = {
    variants: [
      { text: "cover prompt --ar 7:5", nudge: "Cover Reimagining" },
      { text: "motif prompt --ar 7:5", nudge: "Signature Motif" },
      { text: "artist prompt --ar 7:5", nudge: "Visual Artist Provenance" },
      { text: "live prompt --ar 7:5", nudge: "Live Performance Era" },
      { text: "lore prompt --ar 7:5", nudge: "Album Lore" },
    ],
    selectedIndex: 0,
    generator: "gemini",
    generatedAt: "2026-07-23T00:00:00Z",
  };
  // A `run` that actually invokes the action so the api spy records the call.
  const run = ((fn: () => Promise<unknown>) => {
    void fn();
    return Promise.resolve();
  }) as unknown as Parameters<typeof PromptBlock>[0]["run"];

  it("renders every prompt in full, each with its own Copy button", () => {
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={fivePrompts}
        run={vi.fn()}
      />,
    );
    // All five prompt texts are on screen (no pick-one hiding), one per option.
    for (const v of fivePrompts.variants)
      expect(screen.getByText(v.text)).toBeTruthy();
    expect(screen.getByText(/Cover Reimagining/)).toBeTruthy();
    expect(screen.getAllByText("Copy")).toHaveLength(5);
  });

  it("copies the specific prompt whose Copy button is clicked", () => {
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={fivePrompts}
        run={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByText("Copy")[2]!);
    expect(writeText).toHaveBeenCalledWith("artist prompt --ar 7:5");
  });

  it("generates art from a single prompt against its index when enabled", async () => {
    const gen = vi
      .spyOn(api, "generateCardArtOne")
      .mockResolvedValue({ cardArtCandidates: [] });
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={fivePrompts}
        run={run}
        canGenerate
      />,
    );
    const buttons = screen.getAllByText("Generate art");
    expect(buttons).toHaveLength(5);
    fireEvent.click(buttons[3]!); // the "Live Performance Era" prompt → index 3
    await waitFor(() => expect(gen).toHaveBeenCalledWith("abcd1234", 3));
  });

  it("hides the per-prompt Generate art buttons when API generation is off", () => {
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="cardArt"
        prompt={fivePrompts}
        run={vi.fn()}
        canGenerate={false}
      />,
    );
    expect(screen.queryByText("Generate art")).toBeNull();
    // Copy is always available so you can still take the prompt to Google Flow by hand.
    expect(screen.getAllByText("Copy")).toHaveLength(5);
  });
});

// The video prompt block surfaces all prompts, each individually copyable and (when API generation is
// enabled) individually generatable as an Omni clip via a per-prompt background job (ADR 0022).
describe("PromptBlock — video prompt set (ADR 0022)", () => {
  const videoPrompts: DraftedPrompt = {
    variants: [
      { text: "cover in motion", nudge: "Cover in Motion" },
      { text: "signature motif", nudge: "Signature Motif" },
      { text: "live era", nudge: "Live Performance Era" },
    ],
    selectedIndex: 0,
    generator: "gemini",
    generatedAt: "2026-07-23T00:00:00Z",
  };

  it("renders every video prompt in full, each with its own Copy button", () => {
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={videoPrompts}
        run={vi.fn()}
      />,
    );
    for (const v of videoPrompts.variants)
      expect(screen.getByText(v.text)).toBeTruthy();
    expect(screen.getByText(/Cover in Motion/)).toBeTruthy();
    expect(screen.getAllByText("Copy")).toHaveLength(3);
  });

  it("generates a clip from a single prompt against its index when enabled", async () => {
    const gen = vi
      .spyOn(api, "generateVideoOne")
      .mockResolvedValue(doneJob("video"));
    // The per-prompt hooks re-attach on mount via albumJobs — stub it so none are found running.
    vi.spyOn(api, "albumJobs").mockResolvedValue({ jobs: [] });
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={videoPrompts}
        run={vi.fn()}
        canGenerate
        refresh={vi.fn()}
      />,
    );
    const buttons = screen.getAllByText("Generate clip");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[2]!); // the "Live Performance Era" prompt → index 2
    await waitFor(() => expect(gen).toHaveBeenCalledWith("abcd1234", 2));
  });

  it("hides the per-prompt Generate clip buttons when API generation is off", () => {
    render(
      <PromptBlock
        curatorId="abcd1234"
        type="video"
        prompt={videoPrompts}
        run={vi.fn()}
        canGenerate={false}
      />,
    );
    expect(screen.queryByText("Generate clip")).toBeNull();
    expect(screen.getAllByText("Copy")).toHaveLength(3);
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

describe("VideoSection — splice (issue #29)", () => {
  const withClips = (n: number) =>
    albumAt("awaiting_review", {
      videoClips: Array.from({ length: n }, (_, i) => ({
        index: i,
        fileId: `abcd1234-v${i}`,
        nudge: `motion ${i}`,
        generatedAt: "x",
      })),
    });
  // A `run` that actually invokes the action so the api spy records the call.
  const run = ((fn: () => Promise<unknown>) => {
    void fn();
    return Promise.resolve();
  }) as unknown as Parameters<typeof VideoSection>[0]["run"];

  it("splices all clips in index order by default", async () => {
    const splice = vi.spyOn(api, "spliceVisualizer").mockResolvedValue({
      state: "awaiting_preview",
      visualizer: {} as never,
    });
    render(
      <VideoSection curatorId="abcd1234" asset={withClips(3)} run={run} />,
    );
    fireEvent.click(screen.getByText(/Splice 3 clips into loop/));
    await waitFor(() =>
      // 3rd arg is the crossfade seconds — undefined unless the box is checked (issue #56).
      expect(splice).toHaveBeenCalledWith("abcd1234", [0, 1, 2], undefined),
    );
  });

  it("reorders and deselects before splicing", async () => {
    const splice = vi.spyOn(api, "spliceVisualizer").mockResolvedValue({
      state: "awaiting_preview",
      visualizer: {} as never,
    });
    render(
      <VideoSection curatorId="abcd1234" asset={withClips(3)} run={run} />,
    );
    // Deselect motion 1 → order [0, 2]; then move motion 2 earlier → [2, 0].
    fireEvent.click(screen.getByLabelText("Remove motion 1"));
    fireEvent.click(screen.getByLabelText("Move motion 2 earlier"));
    fireEvent.click(screen.getByText(/Splice 2 clips into loop/));
    await waitFor(() =>
      expect(splice).toHaveBeenCalledWith("abcd1234", [2, 0], undefined),
    );
  });

  it("sends the crossfade duration when the seam-crossfade box is checked (issue #56)", async () => {
    const splice = vi.spyOn(api, "spliceVisualizer").mockResolvedValue({
      state: "awaiting_preview",
      visualizer: {} as never,
    });
    render(
      <VideoSection curatorId="abcd1234" asset={withClips(2)} run={run} />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Crossfade the seams/ }),
    );
    fireEvent.click(screen.getByText(/Splice 2 clips into loop/));
    await waitFor(() =>
      expect(splice).toHaveBeenCalledWith("abcd1234", [0, 1], 0.5),
    );
  });

  it("re-includes an excluded clip", async () => {
    render(
      <VideoSection curatorId="abcd1234" asset={withClips(2)} run={run} />,
    );
    fireEvent.click(screen.getByLabelText("Remove motion 0"));
    expect(screen.getByText(/Splice 1 clip into loop/)).toBeTruthy();
    fireEvent.click(screen.getByText("+ motion 0")); // from the Excluded row
    expect(screen.getByText(/Splice 2 clips into loop/)).toBeTruthy();
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

  // Issue #152 / ADR 0032: a refused option used to be an unexplained gap in the gallery.
  it("names each refused option and its reason", () => {
    const asset = withCardPrompt({
      cardArtCandidates: [
        {
          index: 1,
          fileId: "abcd1234-c1",
          ext: "png",
          nudge: "shimmer",
          generatedAt: "x",
        },
      ],
      cardArtRefusals: [
        {
          index: 0,
          nudge: "cover reimagining",
          reason: "IMAGE_RECITATION",
          retriedWithoutCover: true,
          at: "x",
        },
      ],
    });
    render(<CardArtSection curatorId="abcd1234" asset={asset} run={vi.fn()} />);
    expect(screen.getByText(/Gemini declined some options/)).toBeTruthy();
    expect(screen.getByText(/cover reimagining/)).toBeTruthy();
    expect(screen.getByText(/IMAGE_RECITATION/)).toBeTruthy();
    // The retry is worth stating: it says the cover reference was already ruled out.
    expect(
      screen.getByText(/also refused without the cover reference/),
    ).toBeTruthy();
  });

  it("marks a candidate that only generated without the cover reference", () => {
    const asset = withCardPrompt({
      cardArtCandidates: [
        {
          index: 0,
          fileId: "abcd1234-c0",
          ext: "png",
          nudge: "cover reimagining",
          coverReferenceDropped: true,
          generatedAt: "x",
        },
      ],
    });
    render(<CardArtSection curatorId="abcd1234" asset={asset} run={vi.fn()} />);
    expect(screen.getByText(/without cover reference/)).toBeTruthy();
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

describe("TagWriteSection (issue #55)", () => {
  it("marks the sleeve tag written and can't verify before the album is ready", () => {
    const run = vi.fn();
    render(
      <MemoryRouter>
        <TagWriteSection
          curatorId="abcd1234"
          asset={albumAt("awaiting_tag_write")}
          run={run}
        />
      </MemoryRouter>,
    );
    // The payload to write is shown, and the verify button is disabled until awaiting_verify.
    expect(screen.getByText("curator:album:abcd1234")).toBeTruthy();
    expect(
      screen.getByText("Mark physically verified").closest("button")!.disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText("Mark sleeve tag written"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("offers a distinct card URI + card .nfc download (ADR 0023)", () => {
    render(
      <MemoryRouter>
        <TagWriteSection
          curatorId="abcd1234"
          asset={albumAt("awaiting_tag_write")}
          run={vi.fn()}
        />
      </MemoryRouter>,
    );
    // Sleeve is curator:album, card is curator:card — different URIs on the two stickers.
    expect(screen.getByText("curator:album:abcd1234")).toBeTruthy();
    expect(screen.getByText("curator:card:abcd1234")).toBeTruthy();
    // Each object has its own Flipper .nfc download; the card one carries ?object=card.
    const cardDl = screen.getByText("Download card tag .nfc").closest("a")!;
    expect(cardDl.getAttribute("href")).toBe(
      "/api/albums/abcd1234/tag.nfc?object=card",
    );
    const sleeveDl = screen.getByText("Download sleeve tag .nfc").closest("a")!;
    expect(sleeveDl.getAttribute("href")).toBe("/api/albums/abcd1234/tag.nfc");
  });

  it("shows the sleeve as done and enables verify at awaiting_verify", () => {
    const run = vi.fn();
    render(
      <MemoryRouter>
        <TagWriteSection
          curatorId="abcd1234"
          asset={albumAt("awaiting_verify", {
            tag: {
              payload: "curator:album:abcd1234",
              sleeve: { written: true, writtenAt: "2026-07-22T00:00:00Z" },
            },
          })}
          run={run}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("✓ sleeve tag written")).toBeTruthy();
    fireEvent.click(screen.getByText("Mark physically verified"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows the verified banner once done", () => {
    render(
      <MemoryRouter>
        <TagWriteSection
          curatorId="abcd1234"
          asset={albumAt("verified")}
          run={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/fully onboarded/)).toBeTruthy();
    expect(screen.queryByText("Mark physically verified")).toBeNull();
  });
});

/**
 * The tag payload + QR (issue #102). Fetched, never composed here: this string is burned onto a
 * physical sticker, and a mistyped curatorId fails silently — the tag writes fine and simply never
 * resolves at scan time.
 */
describe("TagWriteSection — payload + QR", () => {
  const tagged = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
    ({
      curatorId: "abcd1234",
      metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
      roadie: { state: "awaiting_tag_write", flags: {} },
      ...over,
    }) as AlbumAsset;

  const renderTag = (over: Partial<AlbumAsset> = {}) =>
    render(
      <MemoryRouter>
        <TagWriteSection
          curatorId="abcd1234"
          asset={tagged(over)}
          run={async (fn) => {
            await fn();
          }}
        />
      </MemoryRouter>,
    );

  it("shows a QR and the server's payload for each object", async () => {
    vi.spyOn(api, "tagPayload").mockImplementation(async (_id, object) => ({
      object,
      payload:
        object === "card" ? "curator:card:abcd1234" : "curator:album:abcd1234",
      qrDataUrl: `data:image/svg+xml;base64,${object}`,
    }));

    renderTag();

    // Both objects are fetched independently — a sleeve and a card carry different URIs (ADR 0023).
    await waitFor(() => expect(api.tagPayload).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("curator:album:abcd1234")).toBeTruthy();
    expect(screen.getByText("curator:card:abcd1234")).toBeTruthy();
    expect(document.querySelectorAll("img.tagwrite__qr")).toHaveLength(2);
  });

  it("labels the QR for screen readers with the payload it encodes", async () => {
    vi.spyOn(api, "tagPayload").mockResolvedValue({
      object: "sleeve",
      payload: "curator:album:abcd1234",
      qrDataUrl: "data:image/svg+xml;base64,x",
    });
    renderTag();
    expect(
      await screen.findAllByAltText(/QR code for curator:album:abcd1234/),
    ).not.toHaveLength(0);
  });

  // A failed QR fetch must not block tag writing — the Flipper .nfc download beside it still works.
  it("falls back to the derivable URI when the payload fetch fails", async () => {
    vi.spyOn(api, "tagPayload").mockRejectedValue(new Error("offline"));
    renderTag();

    expect(await screen.findByText("curator:album:abcd1234")).toBeTruthy();
    expect(screen.getByText("curator:card:abcd1234")).toBeTruthy();
    expect(screen.getAllByText("QR unavailable").length).toBeGreaterThan(0);
  });
});
