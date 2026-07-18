import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  api: { spotifySettings: vi.fn(), saveSpotifySettings: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { api } from "../api";
import { Settings } from "./Settings";

const renderSettings = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(api.spotifySettings).mockResolvedValue({
    configured: false,
    clientId: null,
  });
  vi.mocked(api.saveSpotifySettings).mockResolvedValue({
    ok: true,
    restartRequired: true,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings", () => {
  it("shows not-configured, then saves creds and prompts to restart", async () => {
    renderSettings();
    await screen.findByText(/not configured/i);

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "cid" },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "csec" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(api.saveSpotifySettings).toHaveBeenCalledWith("cid", "csec"),
    );
    await screen.findByText(/restart marquee/i);
  });

  it("shows connected when already configured", async () => {
    vi.mocked(api.spotifySettings).mockResolvedValue({
      configured: true,
      clientId: "cid12345",
    });
    renderSettings();
    await screen.findByText(/connected/i);
  });
});
