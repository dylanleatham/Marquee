// Preview's two modes and the room-arm gate (ADR 0028). The property that matters most is the
// safety one: clicking into Preview must never be able to change the lights in an occupied room.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AlbumAsset } from "../api";

vi.mock("../api", () => ({
  api: {
    simulateScan: vi.fn(),
    simulateScanStop: vi.fn(),
    approvePreview: vi.fn(),
    rejectPreview: vi.fn(),
    deskAudioPlay: vi.fn(),
    deskAudioPause: vi.fn(),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
  videoUrl: (id: string) => `/api/albums/${id}/video`,
  thumbnailUrl: (id: string) => `/api/albums/${id}/thumbnail`,
}));

import { api } from "../api";
import { PreviewWorkstation } from "./PreviewWorkstation";
import { setRoomArm, resetRoomArmCache, BENCH_REASON } from "../roomArm";

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abcd1234",
    createdAt: "2026-07-25T00:00:00Z",
    metadata: {
      name: "Purple Rain",
      artist: "Prince",
      source: "spotify",
      spotifyUri: "spotify:album:1C2h7mLntPSeVYciMRTF4a",
    },
    palette: {
      colors: [
        { hex: "#4B0082", role: "primary" },
        { hex: "#FFD700", role: "accent" },
      ],
    },
    roadie: {
      state: "awaiting_preview",
      subState: null,
      flags: {},
      history: [],
      lastError: null,
      retryCount: 0,
    },
    status: { highLevel: "awaiting_preview", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const renderPreview = (over: Partial<AlbumAsset> = {}) =>
  render(
    <MemoryRouter>
      <PreviewWorkstation
        curatorId="abcd1234"
        asset={asset(over)}
        run={async (fn) => {
          await fn();
        }}
      />
    </MemoryRouter>,
  );

const roomTab = () => screen.getByRole("tab", { name: /Room rehearsal/ });

describe("PreviewWorkstation", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRoomArmCache();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("defaults to bench and shows the sleeve alongside the palette", () => {
    renderPreview();
    expect(
      screen.getByRole("tab", { name: /Bench/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("On the stand")).toBeTruthy();
    expect(document.querySelector(".palette-stage")).toBeTruthy();
  });

  // The safety property. Bench is the default and it has no path to the hardware at all.
  it("never calls a hardware route from the bench", async () => {
    renderPreview();
    fireEvent.click(screen.getByText("Looks good →"));
    await waitFor(() => expect(api.approvePreview).toHaveBeenCalled());
    expect(api.simulateScan).not.toHaveBeenCalled();
  });

  it("disables room rehearsal while the room is disarmed, and says why", () => {
    renderPreview();
    expect(roomTab().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(BENCH_REASON)).toBeTruthy();
  });

  it("enables room rehearsal once the room is armed", () => {
    setRoomArm("live");
    renderPreview();
    expect(roomTab().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(BENCH_REASON)).toBeNull();
  });

  it("fans out and reports each leg when the sleeve is placed", async () => {
    setRoomArm("live");
    vi.mocked(api.simulateScan).mockResolvedValue({
      services: [
        { service: "conductor", ok: true },
        { service: "backdrop", ok: false, reason: "not configured" },
        { service: "amp", ok: true },
      ],
    });
    renderPreview();
    fireEvent.click(roomTab());
    fireEvent.click(screen.getByText("Place sleeve"));

    await waitFor(() =>
      expect(api.simulateScan).toHaveBeenCalledWith("abcd1234"),
    );
    // A dead or absent service degrades the rehearsal — it is reported, not thrown.
    expect(await screen.findByText(/Display/)).toBeTruthy();
    expect(screen.getByText(/not configured/)).toBeTruthy();
    expect(screen.getByText(/Lights/)).toBeTruthy();
  });

  it("stops the rehearsal when the sleeve is lifted", async () => {
    setRoomArm("live");
    vi.mocked(api.simulateScanStop).mockResolvedValue({
      services: [{ service: "conductor", ok: true }],
    });
    renderPreview();
    fireEvent.click(roomTab());
    fireEvent.click(screen.getByText("Lift sleeve"));

    await waitFor(() =>
      expect(api.simulateScanStop).toHaveBeenCalledWith("abcd1234"),
    );
  });

  // Disarming mid-rehearsal must not leave the room running.
  it("falls back to the bench and stops the room when disarmed mid-rehearsal", async () => {
    setRoomArm("live");
    vi.mocked(api.simulateScan).mockResolvedValue({
      services: [{ service: "conductor", ok: true }],
    });
    vi.mocked(api.simulateScanStop).mockResolvedValue({ services: [] });
    renderPreview();
    fireEvent.click(roomTab());
    fireEvent.click(screen.getByText("Place sleeve"));
    await waitFor(() => expect(api.simulateScan).toHaveBeenCalled());

    setRoomArm("bench");

    await waitFor(() => expect(api.simulateScanStop).toHaveBeenCalled());
    expect(
      screen.getByRole("tab", { name: /Bench/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("still previews an album with no visualizer attached", () => {
    renderPreview({ visualizer: undefined });
    expect(screen.getByText(/No visualizer attached yet/)).toBeTruthy();
    expect(screen.getByText("On the stand")).toBeTruthy();
  });
});

// Desk audio (ADR 0037): bench preview's audio leg. It plays on the workstation's own Spotify
// client, which is a takeover the producer has to be told about, and it must never outlive the
// bench that started it.
describe("PreviewWorkstation — desk audio", () => {
  const deskButton = () => screen.getByRole("button", { name: /at the desk/ });

  beforeEach(() => {
    localStorage.clear();
    resetRoomArmCache();
    // Unmounting a playing bench pauses the desk, so every test in here can reach the pause call.
    vi.mocked(api.deskAudioPause).mockResolvedValue({ paused: true });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("says the play control takes over Spotify, before it does", () => {
    renderPreview();
    expect(deskButton().textContent).toMatch(/takes over Spotify/);
  });

  it("names the device once it's playing, and offers to pause", async () => {
    vi.mocked(api.deskAudioPlay).mockResolvedValue({
      played: true,
      device: "DESKTOP-1",
    });
    renderPreview();
    fireEvent.click(deskButton());

    await waitFor(() =>
      expect(api.deskAudioPlay).toHaveBeenCalledWith("abcd1234"),
    );
    expect(await screen.findByText(/Playing on DESKTOP-1/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Pause desk audio/ }),
    ).toBeTruthy();
  });

  // §10: a failure is reported in place, and the rest of bench preview keeps working.
  it("shows why it couldn't play, and leaves the control ready to retry", async () => {
    vi.mocked(api.deskAudioPlay).mockResolvedValue({
      played: false,
      reason: "No desktop Spotify client running on this machine",
    });
    renderPreview();
    fireEvent.click(deskButton());

    expect(await screen.findByText(/No desktop Spotify client/)).toBeTruthy();
    expect(deskButton()).toBeTruthy(); // still the play control, not a pause
    expect(screen.getByText("On the stand")).toBeTruthy(); // bench still works
  });

  it("pauses again on request", async () => {
    vi.mocked(api.deskAudioPlay).mockResolvedValue({
      played: true,
      device: "DESKTOP-1",
    });
    vi.mocked(api.deskAudioPause).mockResolvedValue({ paused: true });
    renderPreview();
    fireEvent.click(deskButton());
    fireEvent.click(await screen.findByRole("button", { name: /Pause desk/ }));

    await waitFor(() =>
      expect(api.deskAudioPause).toHaveBeenCalledWith("abcd1234"),
    );
    await waitFor(() => expect(deskButton()).toBeTruthy());
  });

  // Desk audio must not outlive the bench: leaving for room rehearsal pauses what it started.
  it("pauses when the bench goes away", async () => {
    setRoomArm("live");
    vi.mocked(api.deskAudioPlay).mockResolvedValue({
      played: true,
      device: "DESKTOP-1",
    });
    vi.mocked(api.deskAudioPause).mockResolvedValue({ paused: true });
    renderPreview();
    fireEvent.click(deskButton());
    await screen.findByText(/Playing on DESKTOP-1/);

    fireEvent.click(roomTab());

    await waitFor(() => expect(api.deskAudioPause).toHaveBeenCalled());
  });

  it("doesn't pause a desk that was never playing", async () => {
    setRoomArm("live");
    renderPreview();
    fireEvent.click(roomTab());
    expect(api.deskAudioPause).not.toHaveBeenCalled();
  });

  // The unmount cleanup runs before an in-flight play resolves, so it sees nothing playing and
  // pauses nothing — and the desk would then play on with no screen left to stop it. Clicking play
  // and leaving immediately is an ordinary thing to do.
  it("pauses a play that landed after the bench was already gone", async () => {
    let resolvePlay: (r: {
      played: boolean;
      device?: string;
    }) => void = () => {};
    vi.mocked(api.deskAudioPlay).mockReturnValue(
      new Promise((resolve) => {
        resolvePlay = resolve;
      }),
    );
    const view = renderPreview();
    fireEvent.click(deskButton());
    await waitFor(() => expect(api.deskAudioPlay).toHaveBeenCalled());

    view.unmount(); // navigate away while Spotify is still starting the album
    resolvePlay({ played: true, device: "DESKTOP-1" });

    await waitFor(() =>
      expect(api.deskAudioPause).toHaveBeenCalledWith("abcd1234"),
    );
  });

  // A failed action never silently reverts (§10): the control still says "pause", and says why.
  it("keeps the pause control and the reason when pausing fails", async () => {
    vi.mocked(api.deskAudioPlay).mockResolvedValue({
      played: true,
      device: "DESKTOP-1",
    });
    vi.mocked(api.deskAudioPause).mockResolvedValue({
      paused: false,
      reason: "Spotify session expired — reconnect it in Settings",
    });
    renderPreview();
    fireEvent.click(deskButton());
    fireEvent.click(await screen.findByRole("button", { name: /Pause desk/ }));

    expect(await screen.findByText(/session expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pause desk/ })).toBeTruthy();
  });

  // A request that never reached Curator would otherwise leave the button idle with nothing said.
  it("says so when the request itself fails", async () => {
    vi.mocked(api.deskAudioPlay).mockRejectedValue(new Error("network down"));
    renderPreview();
    fireEvent.click(deskButton());

    expect(await screen.findByText(/Couldn't reach Curator/)).toBeTruthy();
  });

  // §4: a disabled control always carries its reason.
  it("disables the control with a reason for an album that isn't on Spotify", () => {
    renderPreview({
      metadata: { name: "Private Press", artist: "Nobody", source: "manual" },
    } as Partial<AlbumAsset>);

    expect(deskButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/isn't on Spotify/)).toBeTruthy();
    expect(api.deskAudioPlay).not.toHaveBeenCalled();
  });
});
