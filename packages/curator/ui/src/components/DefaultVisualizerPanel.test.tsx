// The default-visualizer panel (ADR 0073). Two things matter here and the rest is chrome: the clip
// is judgeable before 441 records inherit it, and the Backdrop leg admits **all three** of its
// states — because "can't tell" drawn as "fine" is the exact failure ADR 0072 exists to prevent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";

vi.mock("../api", () => ({
  api: {
    defaultVisualizer: vi.fn(),
    uploadDefaultVisualizer: vi.fn().mockResolvedValue({}),
    pushDefaultVisualizer: vi.fn().mockResolvedValue({}),
    removeDefaultVisualizer: vi.fn().mockResolvedValue({}),
  },
}));

// The push is a real library-scoped job store (ADR 0074) — polling, backoff and the unreachable
// verdict belong to `libraryJob.ts` and are tested there. Faked here so this file can drive the
// states it renders without standing up a timer.
const pushJob = vi.fn();
vi.mock("../defaultVisualizerPushJob", () => ({
  useDefaultVisualizerPushJob: () => pushJob(),
  startDefaultVisualizerPush: vi.fn().mockResolvedValue(undefined),
  attachRunningDefaultVisualizerPush: vi.fn().mockResolvedValue(undefined),
  cancelDefaultVisualizerPush: vi.fn().mockResolvedValue(undefined),
}));

import { api, type DefaultVisualizerStatus } from "../api";
import {
  startDefaultVisualizerPush,
  cancelDefaultVisualizerPush,
} from "../defaultVisualizerPushJob";
import { DefaultVisualizerPanel } from "./DefaultVisualizerPanel";

const IDLE = { job: null, error: null, unreachable: false };

const status = (
  over: Partial<DefaultVisualizerStatus> = {},
): DefaultVisualizerStatus => ({
  present: true,
  bytes: 12_000_000,
  meta: {
    originalFilename: "house-loop.mp4",
    durationSec: 20,
    resolution: "1920x1080",
    uploadedAt: "2026-08-12T00:00:00.000Z",
    normalized: false,
  },
  mediaTransfer: "push",
  onBackdrop: "present",
  ...over,
});

const show = async (over: Partial<DefaultVisualizerStatus> = {}) => {
  vi.mocked(api.defaultVisualizer).mockResolvedValue(status(over));
  render(<DefaultVisualizerPanel />);
  await waitFor(() => expect(api.defaultVisualizer).toHaveBeenCalled());
};

beforeEach(() => {
  vi.clearAllMocks();
  pushJob.mockReturnValue(IDLE);
});
afterEach(cleanup);

describe("DefaultVisualizerPanel", () => {
  it("says what the setting is for without jargon", async () => {
    await show();
    expect(screen.getByText(/no visualizer of its own yet/i)).toBeTruthy();
  });

  // The empty state has to state the *consequence*, not just the absence: with nothing set, every
  // unfinished record shows nothing at all, which looks like a broken display rather than a setting.
  it("with nothing set, says those records currently show nothing", async () => {
    await show({ present: false, bytes: null, meta: null });
    expect(await screen.findByText(/show nothing at all/i)).toBeTruthy();
    expect(screen.getByText("CHOOSE A CLIP")).toBeTruthy();
  });

  it("plays the clip so it can be judged before every record inherits it", async () => {
    vi.mocked(api.defaultVisualizer).mockResolvedValue(status());
    const { container } = render(<DefaultVisualizerPanel />);
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());

    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toContain(
      "/api/settings/default-visualizer/video",
    );
    // Looping and muted, like the runtime plays it — a one-shot preview would misrepresent it.
    // `muted` is read as a property: React assigns it directly and never writes the attribute.
    expect(video.hasAttribute("loop")).toBe(true);
    expect((video as HTMLVideoElement).muted).toBe(true);
  });

  /**
   * The preview must sit in its **own** frame. It first shipped wearing the record page's
   * `viz__video`, which is `position: absolute; inset: 6%` and only behaves inside `.viz__stage`'s
   * `position: relative`. A Settings `<section>` establishes no containing block, so the clip
   * positioned against the page and covered the entire screen at 88% of the viewport — every
   * control behind it unreachable.
   *
   * jsdom applies no stylesheet, so this pins the *structure* that makes the CSS correct rather than
   * the computed geometry: the video is inside the frame, and does not borrow the other page's class.
   */
  it("keeps the preview inside its own frame, not the record page's", async () => {
    vi.mocked(api.defaultVisualizer).mockResolvedValue(status());
    const { container } = render(<DefaultVisualizerPanel />);
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());

    const video = container.querySelector("video")!;
    expect(video.className).toBe("dviz__video");
    expect(video.closest(".dviz__stage")).toBeTruthy();
    // The borrowed class is the bug, by name.
    expect(container.querySelector(".viz__video")).toBeNull();
  });

  it("names the clip and its size once one is set", async () => {
    await show();
    expect(await screen.findByText(/house-loop\.mp4/)).toBeTruthy();
    expect(screen.getByText(/1920x1080/)).toBeTruthy();
    expect(screen.getByText("REPLACE")).toBeTruthy();
  });

  it("says when the clip had to be re-encoded, and why that was necessary", async () => {
    await show({ meta: { ...status().meta!, normalized: true } });
    expect(await screen.findByText(/H\.264 in software/i)).toBeTruthy();
  });

  it("does not claim a re-encode that didn't happen", async () => {
    await show();
    await screen.findByText(/house-loop\.mp4/);
    expect(screen.queryByText(/H\.264 in software/i)).toBeNull();
  });

  // The three answers. Each says its meaning in words — the dot is `aria-hidden` decoration, so the
  // line has to read identically without colour vision.
  describe("the Backdrop leg", () => {
    it("absent → says the screen will show nothing, and offers to send it", async () => {
      await show({ onBackdrop: "absent" });
      expect(await screen.findByText(/Not on Backdrop yet/)).toBeTruthy();
      expect(screen.getByText("SEND IT")).toBeTruthy();
    });

    it("unknown → says it can't tell, and never draws the positive state", async () => {
      await show({ onBackdrop: "unknown" });
      expect(await screen.findByText(/Can't tell/)).toBeTruthy();
      expect(screen.queryByText("on Backdrop")).toBeNull();
    });

    it("present → says so quietly", async () => {
      await show({ onBackdrop: "present" });
      expect(await screen.findByText("on Backdrop")).toBeTruthy();
      expect(screen.queryByText("SEND IT")).toBeNull();
    });

    /**
     * `media_transfer = "none"` is the default (ADR 0038), and in that mode Curator will not move
     * the file however many times you press a button. Saying "not on Backdrop — SEND IT" there would
     * offer an action that cannot work; naming the file you have to copy is the useful answer.
     */
    it("transfer off → tells you to copy the file yourself, and offers no send", async () => {
      await show({ mediaTransfer: "none", onBackdrop: "absent" });
      expect(await screen.findByText(/copy this to the Pi/i)).toBeTruthy();
      expect(screen.getByText("default.mp4")).toBeTruthy();
      expect(screen.queryByText("SEND IT")).toBeNull();
    });

    it("says nothing about Backdrop when there is no clip to have sent", async () => {
      await show({ present: false, bytes: null, meta: null });
      await screen.findByText(/show nothing at all/i);
      expect(screen.queryByText(/Backdrop/)).toBeNull();
    });
  });

  it("offers REMOVE only once something is set", async () => {
    await show({ present: false, bytes: null, meta: null });
    await screen.findByText(/show nothing at all/i);
    expect(screen.queryByText("REMOVE")).toBeNull();

    cleanup();
    await show();
    expect(await screen.findByText("REMOVE")).toBeTruthy();
  });

  // A clip dropped into the media folder by hand is perfectly playable; it simply has no recorded
  // description. The panel must show it rather than pretend nothing is set.
  it("shows a hand-placed clip that has no recorded description", async () => {
    await show({ meta: null });
    expect(await screen.findByText(/placed by hand/)).toBeTruthy();
  });

  /**
   * `unknown` offers a send here where the record page's identical strip does not — deliberately, so
   * it is pinned. There, `unknown` only ever means "Backdrop isn't answering"; here it also covers
   * "no record uses the default yet", which is the normal state right after you choose a clip and
   * the one case where sending is exactly right.
   */
  it("offers a send in the unknown state, unlike the record page's strip", async () => {
    await show({ onBackdrop: "unknown" });
    fireEvent.click(await screen.findByText("SEND IT ANYWAY"));
    await waitFor(() => expect(startDefaultVisualizerPush).toHaveBeenCalled());
  });

  /**
   * A transfer that says nothing makes success and failure look identical — the bug the record
   * page's Backdrop strip was built to fix, and the reason this reuses the shared library-job store
   * rather than firing and forgetting ([ADR 0038](../../../../../docs/adrs/0038-curator-pushes-media-over-http.md)).
   * The link to a Pi has been measured at ~44 KB/s, so this is minutes of screen time.
   */
  describe("while the clip is going to the Pi", () => {
    const running = (transfer?: {
      label: string;
      sent: number;
      total: number;
      startedAt: string;
    }) => ({
      job: {
        id: "j1",
        kind: "defaultVisualizerPush",
        status: "running",
        progress: { done: 0, total: 0 },
        ...(transfer ? { transfer } : {}),
      },
      error: null,
      unreachable: false,
    });

    it("reports percent and bytes, not a bar alone", async () => {
      pushJob.mockReturnValue(
        running({
          label: "house-loop.mp4",
          sent: 5_000_000,
          total: 10_000_000,
          startedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
      );
      await show({ onBackdrop: "absent" });
      expect(await screen.findByText(/Sending to Backdrop — 50%/)).toBeTruthy();
    });

    // Mid-send the Pi genuinely doesn't have it, so "Not on Backdrop yet — SEND IT" would read as a
    // press that missed. The transfer outranks whatever `onBackdrop` says.
    it("outranks the not-on-Backdrop line rather than showing both", async () => {
      pushJob.mockReturnValue(running());
      await show({ onBackdrop: "absent" });
      await screen.findByText(/Sending to Backdrop/);
      expect(screen.queryByText(/Not on Backdrop yet/)).toBeNull();
      expect(screen.queryByText("SEND IT")).toBeNull();
    });

    it("can be stopped — tens of minutes is not something to be trapped in", async () => {
      pushJob.mockReturnValue(running());
      await show({ onBackdrop: "absent" });
      fireEvent.click(await screen.findByText("STOP"));
      await waitFor(() =>
        expect(cancelDefaultVisualizerPush).toHaveBeenCalled(),
      );
    });

    it("says contact was lost rather than freezing the bar", async () => {
      pushJob.mockReturnValue({ ...running(), unreachable: true });
      await show({ onBackdrop: "absent" });
      expect(await screen.findByText(/Lost contact with Curator/)).toBeTruthy();
    });

    it("reports a failed send with its reason, and offers a retry", async () => {
      pushJob.mockReturnValue({
        job: {
          id: "j1",
          kind: "defaultVisualizerPush",
          status: "failed",
          progress: { done: 0, total: 0 },
          error: "ECONNREFUSED 192.168.1.59:4740",
        },
        error: null,
        unreachable: false,
      });
      await show({ onBackdrop: "absent" });
      expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
      expect(screen.getByText("RETRY")).toBeTruthy();
    });
  });

  it("says why a remove failed", async () => {
    vi.mocked(api.removeDefaultVisualizer).mockRejectedValue(
      new Error("settings.json is read-only"),
    );
    await show();

    fireEvent.click(await screen.findByText("REMOVE"));

    expect(await screen.findByText(/read-only/)).toBeTruthy();
  });
});
