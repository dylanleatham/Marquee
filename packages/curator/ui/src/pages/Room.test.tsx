// The room (ADR 0052) — the screen that replaced the bench and the Demo Room with one.
//
// The rules worth pinning: the arm toggle is the only difference between the two, it says which it
// is in words, sign-off lives here and nowhere else, and Conductor failing degrades the room to a
// window rather than blanking it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../api", () => ({
  api: {
    album: vi.fn(),
    demoStatus: vi.fn().mockResolvedValue({
      reachable: true,
      paired: true,
      listeningRoomId: "7",
    }),
    demoRooms: vi
      .fn()
      .mockResolvedValue({ rooms: [{ id: "7", name: "living room" }] }),
    demoSetRoom: vi.fn().mockResolvedValue({ listeningRoomId: "7" }),
    demoPlay: vi.fn().mockResolvedValue({}),
    demoStop: vi.fn().mockResolvedValue({}),
    demoAudio: vi.fn().mockResolvedValue({ played: true }),
    deskAudioPlay: vi.fn().mockResolvedValue({ played: true }),
    setPatternOverride: vi.fn().mockResolvedValue({}),
    approvePreview: vi.fn().mockResolvedValue({ state: "awaiting_tag_write" }),
  },
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));

import {
  api,
  type AlbumAsset,
  type AlbumSummary,
  type RoadieState,
} from "../api";
import { Room } from "./Room";
import { resetRoomArmCache } from "../roomArm";
import { readyToastSnapshot, dismissReadyToast } from "../readyToast";

const asset = (
  over: Partial<AlbumAsset> = {},
  state: RoadieState = "awaiting_preview",
) =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
    palette: {
      colors: [
        { hex: "#4B0082", role: "primary" },
        { hex: "#8A2BE2", role: "secondary" },
      ],
    },
    visualizer: {
      fileId: "abc12345",
      originalFilename: "v.mp4",
      loopStrategy: "loop",
    },
    pattern: { type: "crossfade", params: {} },
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
    status: { highLevel: "", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const ALBUMS = [
  { curatorId: "abc12345", title: "Purple Rain" },
  { curatorId: "zzz99999", title: "Aja" },
] as AlbumSummary[];

const show = (albums: AlbumSummary[] | null = ALBUMS) =>
  render(
    <MemoryRouter initialEntries={["/room/abc12345"]}>
      <Routes>
        <Route path="/room/:curatorId" element={<Room albums={albums} />} />
        <Route path="/" element={<p>the collection</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetRoomArmCache();
  dismissReadyToast();
  vi.mocked(api.album).mockResolvedValue(asset());
});
afterEach(cleanup);

const loaded = () => screen.findByRole("heading", { name: "Purple Rain" });

describe("Room — bench and the real thing, one screen", () => {
  it("opens on bench only, and says so in words", async () => {
    show();
    await loaded();
    const arm = screen.getByRole("switch");
    expect(arm.textContent).toBe("BENCH ONLY");
    expect(arm.getAttribute("aria-checked")).toBe("false");
    // Bench touches nothing in the room.
    expect(api.demoPlay).not.toHaveBeenCalled();
  });

  it("drives the room the moment it is armed, with no confirm dialog", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.demoPlay).toHaveBeenCalledWith("abc12345"));
    expect(screen.getByRole("switch").textContent).toBe("IN THE ROOM");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Issue #277. The room is lights *and* screen. When the screen does not come up the lights still
  // do, so this is a note rather than a failure — but it has to be said, because a black screen is
  // indistinguishable from a record that simply has no visualizer.
  it("says why the screen is dark, without taking the lights down with it", async () => {
    vi.mocked(api.demoPlay).mockResolvedValue({
      playbackId: "pb-1",
      video: { ok: false, reason: "not configured" },
    });
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));

    expect(
      await screen.findByText(/the screen isn't: not configured/i),
    ).toBeTruthy();
    // Still in the room — the lights ran.
    expect(screen.getByRole("switch").textContent).toBe("IN THE ROOM");
  });

  it("changes a light pattern without restarting the video", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.demoPlay).toHaveBeenCalled());
    vi.mocked(api.demoPlay).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "PULSE" }));

    await waitFor(() =>
      expect(api.demoPlay).toHaveBeenCalledWith("abc12345", { video: false }),
    );
  });

  it("says nothing about the screen when the screen is fine", async () => {
    vi.mocked(api.demoPlay).mockResolvedValue({
      playbackId: "pb-1",
      video: { ok: true },
    });
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(api.demoPlay).toHaveBeenCalled());
    expect(screen.queryByText(/the screen isn't/i)).toBeNull();
  });

  it("stops driving the room when it is un-armed", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.demoPlay).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.demoStop).toHaveBeenCalled());
  });

  it("stops driving the room when you leave the screen", async () => {
    // Nothing should keep a room lit for a window nobody is looking at.
    const { unmount } = show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.demoPlay).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(api.demoStop).toHaveBeenCalled());
  });

  it("sends the sound where the arm switch says", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /PLAY THE ALBUM/ }));
    await waitFor(() => expect(api.deskAudioPlay).toHaveBeenCalled());
    expect(api.demoAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /PLAY THE ALBUM/ }));
    await waitFor(() => expect(api.demoAudio).toHaveBeenCalledWith("abc12345"));
  });
});

describe("Room — the control dock", () => {
  it("offers the pattern the record is on as chosen", async () => {
    show();
    await loaded();
    expect(
      screen
        .getByRole("button", { name: "CROSSFADE" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "PULSE" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("shows the knobs the chosen pattern actually has", async () => {
    // Driven by PATTERN_PARAM_SPECS rather than a fixed three: a slider the server would reject is
    // worse than no slider (ADR 0036), and `static` legally carries no params at all.
    show();
    await loaded();
    expect(screen.getByText("Fade")).toBeTruthy();
    expect(screen.getByText("Hold")).toBeTruthy();
  });

  it("says plainly when a pattern has nothing to tune", async () => {
    vi.mocked(api.album).mockResolvedValue(
      asset({ patternOverride: "static" }),
    );
    show();
    await loaded();
    expect(screen.getByText(/nothing to tune/)).toBeTruthy();
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0);
  });

  it("saves a slider against this record, debounced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await loaded();
    const fade = document.querySelector('input[type="range"]')!;
    fireEvent.change(fade, { target: { value: "12000" } });
    fireEvent.change(fade, { target: { value: "14000" } });
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.setPatternOverride).toHaveBeenCalledTimes(1);
    expect(api.setPatternOverride).toHaveBeenCalledWith(
      "abc12345",
      "crossfade",
      expect.objectContaining({ transitionMs: 14000 }),
    );
    vi.useRealTimers();
  });

  it("resets the tuning when the pattern changes", async () => {
    // The previous pattern's knobs mean nothing to the next one, and carrying them over would build
    // a payload for the wrong shape.
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "PULSE" }));
    await waitFor(() =>
      expect(api.setPatternOverride).toHaveBeenCalledWith(
        "abc12345",
        "pulse",
        {},
      ),
    );
  });

  it("shows the pattern a record is really on, even one the dock doesn't name", async () => {
    // A streaming pattern is a legitimate per-album opt-in (ADR 0035). A dock with nothing pressed
    // reads as "no pattern" rather than "one you can't see from here" — which is what the first
    // real record I opened actually looked like.
    vi.mocked(api.album).mockResolvedValue(
      asset({ patternOverride: "aurora" }),
    );
    show();
    await loaded();
    const aurora = screen.getByRole("button", { name: "AURORA" });
    expect(aurora.getAttribute("aria-pressed")).toBe("true");
    // The three named ones are still offered.
    expect(screen.getByRole("button", { name: "CROSSFADE" })).toBeTruthy();
  });

  it("reads a 0–1 scale as a number and a 0–100 one as a percentage", async () => {
    // `aurora.brightness` is 0–1 and `pulse.minBrightness` is 0–100. Matching on the *name* renders
    // a fully-lit room as "1%".
    vi.mocked(api.album).mockResolvedValue(
      asset({ patternOverride: "aurora" }),
    );
    show();
    await loaded();
    expect(screen.getByText("Brightness").parentElement!.textContent).toContain(
      "1",
    );
    expect(
      screen.getByText("Brightness").parentElement!.textContent,
    ).not.toContain("1%");

    cleanup();
    vi.mocked(api.album).mockResolvedValue(asset({ patternOverride: "pulse" }));
    show();
    await loaded();
    expect(screen.getByText("Dim to").parentElement!.textContent).toContain(
      "40%",
    );
  });

  it("has no colour faders — colour is edited on the record", async () => {
    show();
    await loaded();
    expect(screen.queryByText(/colour|color|palette|hex/i)).toBeNull();
  });
});

describe("Room — signing off", () => {
  /** Everything but the lights done, so signing off is genuinely the last outstanding need. */
  const allButLights = (over: Partial<AlbumAsset> = {}) =>
    asset({
      cardArt: { fileId: "abc12345" },
      tag: {
        payload: "curator:album:abc12345",
        sleeve: { written: true },
        card: { written: true },
      },
      verification: { physicallyVerifiedAt: "2026-08-07T10:00:00.000Z" },
      ...over,
    } as Partial<AlbumAsset>);

  it("returns to the collection and fires the toast when that was the last need", async () => {
    vi.mocked(api.album).mockResolvedValue(allButLights());
    vi.mocked(api.approvePreview).mockResolvedValue({
      state: "verified",
      previewApprovedAt: "2026-08-08T10:00:00.000Z",
    });
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Looks right/ }));
    await waitFor(() =>
      expect(api.approvePreview).toHaveBeenCalledWith("abc12345"),
    );
    expect(readyToastSnapshot()).toBe("abc12345");
    await waitFor(() =>
      expect(screen.getByText("the collection")).toBeTruthy(),
    );
  });

  /**
   * regression: #263 — the sign-off used to navigate to the collection and fire "<title> is ready ·
   * Lights, visualizer, card and tags — all done" whatever was still outstanding. On a record that
   * still needs three of the four that is both a lie and the only feedback you got, which is why the
   * user's report read "I am kicked out to the full album list" ([ADR 0063](../../../../../docs/adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).
   */
  it("confirms in place, and does not claim ready, when needs remain", async () => {
    // The default asset has a visualizer but no card and no tags.
    vi.mocked(api.approvePreview).mockResolvedValue({
      state: "awaiting_tag_write",
      previewApprovedAt: "2026-08-08T10:00:00.000Z",
    });
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Looks right/ }));
    await waitFor(() => expect(api.approvePreview).toHaveBeenCalled());

    expect(readyToastSnapshot()).toBeNull();
    expect(screen.queryByText("the collection")).toBeNull();
    expect(screen.getByRole("heading", { name: "Purple Rain" })).toBeTruthy();
  });

  it("says so on the button once the lights are signed off", async () => {
    // regression: #263 — "there doesn't appear to be UI to confirm that lights have been approved".
    vi.mocked(api.album).mockResolvedValue(
      asset({
        verification: { previewApprovedAt: "2026-08-08T10:00:00.000Z" },
      }),
    );
    show();
    await loaded();
    const btn = screen.getByRole("button", { name: /SIGNED OFF/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Signed off .* watch it as often/)).toBeTruthy();
  });

  /**
   * regression: #263 — this replaces "says why it can't be signed off yet", which pinned the gate
   * `state === "awaiting_preview"` faithfully and could not tell that the gate was unreachable for
   * 96% of the collection. The sign-off now asks about the record, so a record with no visualizer
   * signs off like any other.
   */
  it("signs the lights off on a record that has no visualizer", async () => {
    vi.mocked(api.album).mockResolvedValue(
      asset({ visualizer: undefined }, "awaiting_review"),
    );
    vi.mocked(api.approvePreview).mockResolvedValue({
      state: "awaiting_review",
      previewApprovedAt: "2026-08-08T10:00:00.000Z",
    });
    show();
    await loaded();
    const btn = screen.getByRole("button", { name: /Looks right/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.approvePreview).toHaveBeenCalledWith("abc12345"),
    );
  });

  it("won't sign off lights Roadie hasn't pulled yet, and says which", async () => {
    vi.mocked(api.album).mockResolvedValue(
      asset({ palette: undefined }, "generating_palette"),
    );
    show();
    await loaded();
    expect(
      (screen.getByRole("button", { name: /Looks right/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/hasn't pulled the lights/)).toBeTruthy();
  });

  it("says sign-off only happens in here", async () => {
    show();
    await loaded();
    expect(
      screen.getByText("The lights are only signed off from in here."),
    ).toBeTruthy();
  });
});

describe("Room — when the room isn't there", () => {
  it("degrades to a window instead of blanking, and says what broke", async () => {
    vi.mocked(api.demoPlay).mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByText(/connect ECONNREFUSED/)).toBeTruthy(),
    );
    // The record is still on screen — the wash and the clip don't depend on Conductor.
    expect(screen.getByRole("heading", { name: "Purple Rain" })).toBeTruthy();
  });

  it("asks which room only when armed and none is chosen", async () => {
    vi.mocked(api.demoStatus).mockResolvedValue({
      reachable: true,
      paired: true,
      listeningRoomId: null,
    });
    show();
    await loaded();
    expect(screen.queryByRole("combobox")).toBeNull(); // bench: not in the way
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
  });

  it("plays the lights for a record with no visualizer, and says so", async () => {
    vi.mocked(api.album).mockResolvedValue(asset({ visualizer: undefined }));
    show();
    await loaded();
    expect(screen.getByText(/THE LIGHTS STILL PLAY/)).toBeTruthy();
  });

  it("plays the clip on the bench too — that is what a bench preview is", async () => {
    // Bench is the whole preview minus the hardware. Gating the clip on being armed would make the
    // safe mode the useless one.
    show();
    await loaded();
    expect(document.querySelector("video")).toBeTruthy();
    expect(document.querySelector(".room__visualizer--empty")).toBeNull();
  });

  it("moves to the next record on PLACE ANOTHER", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "PLACE ANOTHER" }));
    await waitFor(() => expect(api.album).toHaveBeenCalledWith("zzz99999"));
  });

  it("stops the old record before starting the new one, not alongside it", async () => {
    // Cleanup and the next effect body are both async and neither awaits the other, so an
    // unsequenced stop can land after the play and leave the room dark — pressing PLACE ANOTHER and
    // getting darkness is the exact failure this screen exists to rule out.
    const order: string[] = [];
    vi.mocked(api.demoStop).mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            order.push("stop");
            r({});
          }, 30),
        ),
    );
    vi.mocked(api.demoPlay).mockImplementation(async () => {
      order.push("play");
      return {};
    });

    show();
    await loaded();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(order).toEqual(["play"]));

    fireEvent.click(screen.getByRole("button", { name: "PLACE ANOTHER" }));
    await waitFor(() => expect(order).toEqual(["play", "stop", "play"]));
  });

  it("keeps a slider edit made on the way out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = show();
    await loaded();
    fireEvent.change(document.querySelector('input[type="range"]')!, {
      target: { value: "9000" },
    });
    // Leave before the debounce fires — the write must still happen.
    unmount();
    expect(api.setPatternOverride).toHaveBeenCalledWith(
      "abc12345",
      "crossfade",
      expect.objectContaining({ transitionMs: 9000 }),
    );
    vi.useRealTimers();
  });

  it("takes the sleeve off the stand when asked, and says so", async () => {
    show();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "LIFT THE SLEEVE" }));
    await waitFor(() =>
      expect(screen.getByText("THE SLEEVE IS OFF THE STAND")).toBeTruthy(),
    );
    expect(document.querySelector("video")).toBeNull();
  });
});
