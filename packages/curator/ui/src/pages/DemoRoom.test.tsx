import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AlbumAsset } from "../api";

// Mock the API module: the Demo Room's whole job is orchestrating these calls, so we assert on them.
vi.mock("../api", () => ({
  api: {
    album: vi.fn(),
    albums: vi.fn(),
    demoStatus: vi.fn(),
    demoRooms: vi.fn(),
    demoSetRoom: vi.fn(),
    demoPlay: vi.fn(),
    demoStop: vi.fn(),
  },
  videoUrl: (id: string) => `/api/albums/${id}/video`,
}));

import { api } from "../api";
import { DemoRoom } from "./DemoRoom";

const albumWithVideo: AlbumAsset = {
  curatorId: "abcd1234",
  createdAt: "2026-07-13T00:00:00Z",
  metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
  visualizer: {
    fileId: "abcd1234",
    originalFilename: "clip.mp4",
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
  status: { highLevel: "awaiting_preview", next: null, issues: [] },
} as AlbumAsset;

const renderDemo = () =>
  render(
    <MemoryRouter initialEntries={["/demo/abcd1234"]}>
      <Routes>
        <Route path="/demo/:curatorId" element={<DemoRoom />} />
        <Route path="/albums/:curatorId" element={<div>album page</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(api.album).mockResolvedValue(albumWithVideo);
  vi.mocked(api.albums).mockResolvedValue({ albums: [] });
  vi.mocked(api.demoStatus).mockResolvedValue({
    reachable: true,
    paired: true,
    listeningRoomId: "1",
  });
  vi.mocked(api.demoRooms).mockResolvedValue({ rooms: [] });
  vi.mocked(api.demoPlay).mockResolvedValue({ playbackId: "pb-1" });
  vi.mocked(api.demoStop).mockResolvedValue({ stopped: true });
  vi.mocked(api.demoSetRoom).mockResolvedValue({ listeningRoomId: "1" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DemoRoom", () => {
  it("place sleeve → plays the album's lights; lift sleeve → stops them", async () => {
    renderDemo();
    // Album title loads.
    await waitFor(() => screen.getByText("Purple Rain"));

    fireEvent.click(screen.getByText(/Place sleeve/));
    await waitFor(() => expect(api.demoPlay).toHaveBeenCalledWith("abcd1234"));

    // Control flips to "Lift sleeve".
    const lift = await screen.findByText(/Lift sleeve/);
    fireEvent.click(lift);
    await waitFor(() => expect(api.demoStop).toHaveBeenCalled());
    await screen.findByText(/Place sleeve/); // back to idle
  });

  it("prompts for a room when Conductor is reachable but none is set, and saves the choice", async () => {
    vi.mocked(api.demoStatus).mockResolvedValue({
      reachable: true,
      paired: true,
      listeningRoomId: null,
    });
    vi.mocked(api.demoRooms).mockResolvedValue({
      rooms: [
        { id: "7", name: "Living", type: "Room", lightIds: ["11", "12"] },
      ],
    });

    renderDemo();
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "7" } });
    await waitFor(() => expect(api.demoSetRoom).toHaveBeenCalledWith("7"));
  });

  it("shows the lights offline when Conductor is unreachable, but still lets the video play", async () => {
    vi.mocked(api.demoStatus).mockResolvedValue({
      reachable: false,
      paired: false,
      listeningRoomId: null,
    });
    renderDemo();
    await screen.findByText(/Conductor offline/);
    // The play control is still present — video is local, lights just won't respond.
    expect(screen.getByText(/Place sleeve/)).toBeTruthy();
  });
});
