// The visualizer panel (ADR 0052). What matters here is that a clip is judgeable — it plays, in the
// record's own lights — and that the Backdrop leg admits all three of its states on this page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

vi.mock("../api", () => ({
  api: {
    uploadVideo: vi.fn().mockResolvedValue({}),
    detachVideo: vi.fn().mockResolvedValue({}),
    draftPrompt: vi.fn().mockResolvedValue({}),
    generateVideoSet: vi.fn().mockResolvedValue({}),
    markPromptCopied: vi.fn().mockResolvedValue({}),
    pushAlbum: vi.fn().mockResolvedValue({}),
  },
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  activePromptText: () => "",
}));

// Only the transfer hook is faked — `AsyncButton` reaches for `usePending` from the same module, so
// replacing it wholesale would break every button on the panel.
const transfer = vi.fn();
vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useMediaTransferJob: () => transfer(),
}));

import { api, type AlbumAsset } from "../api";
import { VisualizerPanel, paletteWash } from "./VisualizerPanel";

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Aja", artist: "Steely Dan", source: "manual" },
    palette: {
      colors: [
        { hex: "#1A1A1A", role: "primary" },
        { hex: "#C9403F", role: "secondary" },
      ],
    },
    visualizer: {
      fileId: "abc12345",
      originalFilename: "aja.mp4",
      durationSec: 20,
      resolution: "1920x1080",
      loopStrategy: "loop",
    },
    roadie: {
      state: "awaiting_preview",
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
    status: { highLevel: "", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const show = (a: AlbumAsset = asset(), canGenerate = false) =>
  render(
    <VisualizerPanel
      curatorId="abc12345"
      asset={a}
      refresh={() => {}}
      canGenerate={canGenerate}
      run={async (fn) => {
        await fn();
      }}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  transfer.mockReturnValue({ job: null, startedAt: null });
});
afterEach(cleanup);

/**
 * Drive the OS file chooser that `pickFile` opens.
 *
 * It builds a *detached* input and clicks it — right for the UI (nothing there needs tabbing to; the
 * visible button is the control) and unreachable from the rendered tree, so the test intercepts the
 * element at creation instead. `files` is read-only in jsdom, hence the defineProperty.
 */
const choose = (file: File, click: () => void) => {
  const real = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tag: string) => {
      const el = real(tag);
      if (tag === "input") {
        Object.defineProperty(el, "files", { value: [file] });
        (el as HTMLInputElement).click = () =>
          (el as HTMLInputElement).onchange?.(new Event("change"));
      }
      return el;
    });
  click();
  spy.mockRestore();
};

describe("VisualizerPanel — the clip", () => {
  it("plays it, looping, so it can actually be judged", () => {
    show();
    const video = document.querySelector("video")!;
    // Keyed on the attached file: without the token REPLACE leaves the src unchanged and the browser
    // keeps playing the cached clip (issue #25).
    expect(video.getAttribute("src")).toBe(
      "/api/albums/abc12345/video?v=abc12345",
    );
    expect(video.hasAttribute("loop")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(true);
    // Muted: a clip that starts talking the moment you open a tab is its own bug.
    expect(video.hasAttribute("muted") || video.muted).toBeTruthy();
    expect(screen.getByText("playing · loops seamlessly")).toBeTruthy();
    expect(screen.getByText("1920x1080")).toBeTruthy();
  });

  it("washes the stage in the record's own lights", () => {
    show();
    const stage = document.querySelector(".viz__stage") as HTMLElement;
    // The second colour leads the gradient and the dominant fills it — the same shape the room uses,
    // so what you judge here is what the room will do.
    expect(stage.style.background).toContain("#C9403F 0%");
    expect(stage.style.background).toContain("#1A1A1A 55%");
  });

  it("offers a way in when there is no clip yet, rather than an empty box", () => {
    show(asset({ visualizer: undefined }));
    expect(screen.getByText("No visualizer yet")).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
  });

  it("does not offer to paste a link", () => {
    // Deliberately removed: a URL is not a file, and the one that mattered was always local.
    show();
    expect(screen.queryByText(/paste|link|url/i)).toBeNull();
  });

  it("uploads the clip you pick, from every control that offers to take one", async () => {
    for (const [name, a] of [
      ["PICK A FILE", asset()],
      ["REPLACE", asset()],
      ["No visualizer yet", asset({ visualizer: undefined })],
    ] as const) {
      vi.clearAllMocks();
      show(a);
      const file = new File(["mp4"], "clip.mp4", { type: "video/mp4" });
      choose(file, () =>
        fireEvent.click(screen.getByRole("button", { name: new RegExp(name) })),
      );
      await waitFor(() => expect(api.uploadVideo).toHaveBeenCalled());
      expect(
        (vi.mocked(api.uploadVideo).mock.calls[0]![1] as FormData).get("file"),
      ).toBe(file);
      cleanup();
    }
  });

  it("detaches the clip on REMOVE", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "REMOVE" }));
    await waitFor(() =>
      expect(api.detachVideo).toHaveBeenCalledWith("abc12345"),
    );
  });
});

describe("VisualizerPanel — the Backdrop leg", () => {
  it("says so, quietly, when the clip is there", () => {
    show();
    expect(screen.getByText("on Backdrop")).toBeTruthy();
  });

  it("shows progress in numbers as well as a bar", () => {
    transfer.mockReturnValue({
      job: { status: "running", progress: { done: 68, total: 100 }, id: "j1" },
      startedAt: null,
    });
    show();
    expect(screen.getByText(/Uploading to Backdrop — 68%/)).toBeTruthy();
  });

  it("admits a failure here, with a retry — not only on the System screen", async () => {
    // A clip attached in Curator that never reached Backdrop plays as a black screen in the room.
    // Success and failure used to look identical on this page.
    transfer.mockReturnValue({
      job: {
        status: "failed",
        progress: { done: 1, total: 9 },
        id: "j1",
        error: "connect ECONNREFUSED",
      },
      startedAt: null,
    });
    show();
    expect(screen.getByText(/Upload failed/)).toBeTruthy();
    expect(screen.getByText(/lights still work/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await waitFor(() => expect(api.pushAlbum).toHaveBeenCalledWith("abc12345"));
  });

  it("says nothing at all when there is no clip to send", () => {
    show(asset({ visualizer: undefined }));
    expect(screen.queryByText(/Backdrop/)).toBeNull();
  });
});

describe("VisualizerPanel — the drafts", () => {
  const withDrafts = asset({
    promptDrafts: {
      video: {
        variants: [
          { text: "Slow purple stage haze", nudge: "a" },
          { text: "Rain on a lit window", nudge: "b" },
          { text: "Slow dolly through velvet curtains", nudge: "c" },
        ],
        selectedIndex: 0,
        generator: "gemini",
        generatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });

  it("shows every draft, numbered, each with its own copy", async () => {
    // The old bench showed one behind a variant chooser, so the rest may as well not have existed.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    show(withDrafts);
    expect(screen.getByText("Slow purple stage haze")).toBeTruthy();
    expect(screen.getByText("Rain on a lit window")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "COPY" })).toHaveLength(3);
    expect(screen.getByText("01")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "COPY" })[1]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Rain on a lit window"),
    );
  });

  it("offers to write them when Roadie hasn't", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /DRAFT THEM/ }));
    await waitFor(() =>
      expect(api.draftPrompt).toHaveBeenCalledWith("abc12345", "video"),
    );
  });

  it("marks the metered control as one that spends, and says why it is off", () => {
    show(withDrafts, false);
    const gen = screen.getByRole("button", { name: /LET ROADIE MAKE IT/ });
    expect(gen.textContent).toContain("◈");
    expect((gen as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/off unless you turn it on in settings/),
    ).toBeTruthy();
  });

  it("enables it once generation is turned on", () => {
    show(withDrafts, true);
    expect(
      (
        screen.getByRole("button", {
          name: /LET ROADIE MAKE IT/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe("paletteWash", () => {
  it("falls back to the room floor rather than an empty gradient", () => {
    expect(paletteWash([])).toContain("#0d0a10");
    expect(paletteWash([{ hex: "#ABCDEF", role: "primary" }])).toContain(
      "#ABCDEF",
    );
  });
});
