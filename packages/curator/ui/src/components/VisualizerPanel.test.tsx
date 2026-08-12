// The visualizer panel (ADR 0052). What matters here is that a clip is judgeable — it plays, in the
// record's own lights — and that the Backdrop leg admits all three of its states on this page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
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
    spliceVisualizer: vi.fn().mockResolvedValue({}),
    markPromptCopied: vi.fn().mockResolvedValue({}),
    pushAlbum: vi.fn().mockResolvedValue({}),
    cancelJob: vi.fn().mockResolvedValue({}),
    job: vi.fn(),
    albumJobs: vi.fn().mockResolvedValue({ jobs: [] }),
  },
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  activePromptText: () => "",
}));

// Only the transfer hook is faked — `AsyncButton` reaches for `usePending` from the same module, so
// replacing it wholesale would break every button on the panel.
const transfer = vi.fn();
const presence = vi.fn();
vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useMediaTransferJob: () => transfer(),
  useBackdropPresence: () => presence(),
}));

import { api, type AlbumAsset, type AlbumPresence } from "../api";
import { presenceProblem } from "../system";
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
  // Default to Backdrop confirming the clip. Every resting-state assertion sets this explicitly —
  // the bug in #296 was precisely that the panel had a default of "fine" and never asked.
  presence.mockReturnValue({ presence: "present", refresh: () => {} });
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

/**
 * The window between picking a file and the server answering (issue #284).
 *
 * It used to render nothing at all: the panel kept saying "No visualizer yet" (or kept playing the
 * old clip on REPLACE) for the length of a several-hundred-megabyte transfer, which reads as a press
 * that missed — the reported symptom was navigating away and back to find the clip already there.
 * The one test that touched upload asserted the call was made and the mock's promise resolved, which
 * is precisely the moment the gap is invisible.
 */
describe("VisualizerPanel — the clip on its way in", () => {
  /** Hold the upload open, so the in-flight window can be inspected rather than raced past. */
  const holdUpload = () => {
    let report: (sent: number, total: number) => void = () => {};
    let land: () => void = () => {};
    vi.mocked(api.uploadVideo).mockImplementation(
      (_id, _form, opts) =>
        new Promise((resolve) => {
          report = (sent, total) => opts?.onProgress?.(sent, total);
          land = () => resolve({} as never);
        }),
    );
    return {
      report: (sent: number, total: number) => act(() => report(sent, total)),
      land: () => act(async () => land()),
    };
  };

  const start = async (a: AlbumAsset, control: RegExp) => {
    const upload = holdUpload();
    show(a);
    choose(new File(["mp4"], "clip.mp4", { type: "video/mp4" }), () =>
      fireEvent.click(screen.getByRole("button", { name: control })),
    );
    await waitFor(() => expect(api.uploadVideo).toHaveBeenCalled());
    return upload;
  };

  const strip = () => screen.getByRole("status").textContent ?? "";

  it("says so, in percent and bytes, while the bytes are moving", async () => {
    const upload = await start(
      asset({ visualizer: undefined }),
      /No visualizer yet/,
    );
    upload.report(5 * 1024 * 1024, 20 * 1024 * 1024);
    // Never the bar alone (curator-ui-ux §3.4) — the same shape the Backdrop strip below it uses, so
    // the two legs of the same transfer read as one system.
    expect(strip()).toContain("Sending clip.mp4");
    expect(strip()).toContain("25%");
    expect(strip()).toContain("5.0 MB of 20.0 MB");
  });

  it("stops claiming a percentage once every byte is out and Curator is still working", async () => {
    // Against a local server this is most of the wait — the bytes land at once and the server then
    // probes the file and copies it into place. A bar frozen at 100% reads as a stall.
    const upload = await start(
      asset({ visualizer: undefined }),
      /No visualizer yet/,
    );
    upload.report(20 * 1024 * 1024, 20 * 1024 * 1024);
    expect(strip()).toContain("Adding clip.mp4 to the record");
  });

  it("shuts the controls that would start a second upload", async () => {
    const upload = await start(asset(), /REPLACE/);
    upload.report(1, 2);
    for (const name of ["REPLACE", "PICK A FILE"])
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
  });

  it("says nothing once the clip has landed", async () => {
    const upload = await start(
      asset({ visualizer: undefined }),
      /No visualizer yet/,
    );
    upload.report(1, 2);
    expect(screen.queryByText(/Sending clip.mp4/)).toBeTruthy();
    await upload.land();
    await waitFor(() =>
      expect(screen.queryByText(/Sending clip.mp4/)).toBeNull(),
    );
  });
});

describe("VisualizerPanel — the Backdrop leg", () => {
  it("says so, quietly, when Backdrop confirms the clip is there", () => {
    presence.mockReturnValue({ presence: "present", refresh: () => {} });
    show();
    expect(screen.getByText("on Backdrop")).toBeTruthy();
  });

  /**
   * Issue #296. The green dot used to be the *fallback* branch — reached whenever no transfer job
   * was running or failed — so a clip that was never pushed read as delivered. ZABA (Glass Animals)
   * was the live case: the record page said "on Backdrop", Backdrop's library had no entry, and the
   * room would have played a black screen.
   */
  it("does not claim the clip is there when Backdrop has not got it", () => {
    presence.mockReturnValue({ presence: "absent", refresh: () => {} });
    show();
    expect(screen.queryByText("on Backdrop")).toBeNull();
    expect(screen.getByText(/not on Backdrop/)).toBeTruthy();
  });

  it("offers the push from the resting state, not only after a failed job", async () => {
    // The retry was reachable only from `job.status === "failed"`, so a never-pushed clip had no way
    // out of the UI at all — the fix for ZABA was a curl against the push route.
    presence.mockReturnValue({ presence: "absent", refresh: () => {} });
    show();
    fireEvent.click(screen.getByRole("button", { name: /SEND IT/ }));
    await waitFor(() => expect(api.pushAlbum).toHaveBeenCalledWith("abc12345"));
  });

  it("stays quiet until the first answer, rather than flashing a verdict", () => {
    // `null` is the window before Backdrop has answered — not an answer. Rendering "can't tell" for
    // the length of one request on every page open would train you to ignore it.
    presence.mockReturnValue({ presence: null, refresh: () => {} });
    show();
    expect(screen.queryByText(/Backdrop/)).toBeNull();
  });

  it("admits it cannot tell rather than showing a positive dot", () => {
    // Backdrop unreachable, or too old to report `fileMissing`. The server already keeps "can't
    // tell" distinct from "fine"; collapsing them here is how this bug returns.
    presence.mockReturnValue({ presence: "unknown", refresh: () => {} });
    show();
    expect(screen.queryByText("on Backdrop")).toBeNull();
    expect(screen.getByText(/Can't tell/)).toBeTruthy();
    expect(document.querySelector(".pp-dot--positive")).toBeNull();
  });

  it("keeps a running or failed transfer ahead of whatever presence says", () => {
    // Presence is the *resting* answer. While bytes are moving, the job is the truer story, and a
    // stale "absent" must not overwrite live progress.
    presence.mockReturnValue({ presence: "absent", refresh: () => {} });
    transfer.mockReturnValue({
      job: { status: "running", progress: { done: 1, total: 4 }, id: "j1" },
      startedAt: null,
    });
    show();
    expect(screen.getByText(/Uploading to Backdrop/)).toBeTruthy();
    expect(screen.queryByText(/not on Backdrop/)).toBeNull();
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

  /**
   * The blind spot behind #296, closed.
   *
   * The defect was never really the wrong label — it was that two screens derived one fact two
   * different ways, so `VisualizerPanel.test.tsx` and `system.test.ts` could both pass while the
   * app contradicted itself. Neither could fail for the other's mistake. This is the assertion that
   * spans them: **the panel confirms exactly when the System page has no complaint**, over every
   * shape `videoPresence` can take.
   */
  it("confirms exactly when the System page has no complaint", () => {
    const cases = [
      { videoPresence: "present", inBackdropLibrary: true, problem: null },
      {
        videoPresence: "absent",
        inBackdropLibrary: false,
        problem: "NOT IN BACKDROP'S LIBRARY",
      },
      {
        videoPresence: "absent",
        inBackdropLibrary: true,
        problem: "NO VISUALIZER ON BACKDROP",
      },
      {
        videoPresence: "unknown",
        inBackdropLibrary: true,
        problem: "NO VISUALIZER ON BACKDROP",
      },
    ] as const;

    for (const c of cases) {
      cleanup();
      const row: AlbumPresence = {
        curatorId: "abc12345",
        name: "Aja",
        artist: "Steely Dan",
        hasVideo: true,
        onConductor: true,
        inBackdropLibrary: c.inBackdropLibrary,
        videoOnBackdrop: c.videoPresence === "present",
        videoPresence: c.videoPresence,
      };
      expect(presenceProblem(row)).toBe(c.problem);

      transfer.mockReturnValue({ job: null, startedAt: null });
      presence.mockReturnValue({
        presence: c.videoPresence,
        refresh: () => {},
      });
      show();
      expect(screen.queryByText("on Backdrop") !== null).toBe(
        c.problem === null,
      );
    }
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

  it("generates and then joins the clips, because the panel can only show a loop", async () => {
    // `generateVideoSet` returns *clips*; this page shows a *visualizer*. Stopping at the clips
    // would leave the button looking like it did nothing (issue #29).
    vi.mocked(api.albumJobs).mockResolvedValue({ jobs: [] });
    vi.mocked(api.generateVideoSet).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "running",
      progress: { done: 0, total: 3 },
      createdAt: "",
      updatedAt: "",
    });
    vi.mocked(api.job).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "done",
      progress: { done: 3, total: 3 },
      createdAt: "",
      updatedAt: "",
    });

    show(withDrafts, true);
    fireEvent.click(screen.getByRole("button", { name: /LET ROADIE MAKE IT/ }));
    await waitFor(() => expect(api.generateVideoSet).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.spliceVisualizer).toHaveBeenCalledWith("abc12345"),
    );
  });

  it("says what went wrong rather than falling silent", async () => {
    vi.mocked(api.albumJobs).mockResolvedValue({ jobs: [] });
    vi.mocked(api.generateVideoSet).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "running",
      progress: { done: 0, total: 3 },
      createdAt: "",
      updatedAt: "",
    });
    vi.mocked(api.job).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "failed",
      progress: { done: 1, total: 3 },
      error: "Veo refused the prompt",
      createdAt: "",
      updatedAt: "",
    });

    show(withDrafts, true);
    fireEvent.click(screen.getByRole("button", { name: /LET ROADIE MAKE IT/ }));
    await waitFor(() =>
      expect(screen.getByText(/Veo refused the prompt/)).toBeTruthy(),
    );
    // And a failed run must not splice — there is nothing whole to join.
    expect(api.spliceVisualizer).not.toHaveBeenCalled();
    // The button comes back, so a retry doesn't need a reload.
    expect(
      screen.getByRole("button", { name: /LET ROADIE MAKE IT/ }),
    ).toBeTruthy();
  });

  it("says how far along it is, and offers a way out", async () => {
    vi.mocked(api.albumJobs).mockResolvedValue({ jobs: [] });
    vi.mocked(api.generateVideoSet).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "running",
      progress: { done: 1, total: 4 },
      createdAt: "",
      updatedAt: "",
    });
    vi.mocked(api.job).mockResolvedValue({
      id: "j9",
      kind: "video",
      status: "running",
      progress: { done: 1, total: 4 },
      createdAt: "",
      updatedAt: "",
    });

    show(withDrafts, true);
    fireEvent.click(screen.getByRole("button", { name: /LET ROADIE MAKE IT/ }));
    await waitFor(() => expect(screen.getByText(/1 of 4/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "STOP" })).toBeTruthy();
  });
});

describe("VisualizerPanel — clips left unjoined", () => {
  // Auto-splice covers the happy path, but it fires from the job completing. Close the app mid-run
  // (the hook adopts a finished job without re-firing it) or have the splice fail, and the clips sit
  // on disk with nothing attached — which is invisible on a page that only renders a visualizer.
  const stranded = asset({
    visualizer: undefined,
    videoClips: [
      { index: 0, fileId: "c0", generatedAt: "" },
      { index: 1, fileId: "c1", generatedAt: "" },
    ],
  });

  it("says the clips exist and offers to join them", async () => {
    show(stranded, true);
    expect(screen.getByText(/Roadie made 2 clips/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "MAKE THE LOOP" }));
    await waitFor(() =>
      expect(api.spliceVisualizer).toHaveBeenCalledWith("abc12345"),
    );
  });

  it("stays quiet once there is a visualizer", () => {
    show(asset({ videoClips: [{ index: 0, fileId: "c0", generatedAt: "" }] }));
    expect(screen.queryByText(/aren't joined up yet/)).toBeNull();
  });

  it("joins only once, however hard the button is pressed", async () => {
    // The strip becomes visible the instant the job reports done — before the automatic splice
    // resolves — so the two paths overlap by construction. A second press must not start a second
    // ffmpeg join over the same clips.
    let release!: () => void;
    vi.mocked(api.spliceVisualizer).mockReturnValue(
      new Promise((r) => {
        release = () => r({} as never);
      }),
    );
    show(stranded, true);
    fireEvent.click(screen.getByRole("button", { name: "MAKE THE LOOP" }));
    await waitFor(() =>
      expect(screen.getByText(/Joining the clips into a loop/)).toBeTruthy(),
    );
    // While it runs the offer is gone, so there is nothing left to press twice.
    expect(screen.queryByRole("button", { name: "MAKE THE LOOP" })).toBeNull();
    release();
    await waitFor(() => expect(api.spliceVisualizer).toHaveBeenCalledTimes(1));
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
