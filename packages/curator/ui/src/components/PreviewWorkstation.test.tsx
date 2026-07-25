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
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
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
