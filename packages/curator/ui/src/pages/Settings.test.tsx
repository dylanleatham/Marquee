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
  api: {
    spotifySettings: vi.fn(),
    saveSpotifySettings: vi.fn(),
    geminiSettings: vi.fn(),
    saveGeminiSettings: vi.fn(),
  },
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
  vi.mocked(api.geminiSettings).mockResolvedValue({ configured: false });
  vi.mocked(api.saveGeminiSettings).mockResolvedValue({
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
    await screen.findByText(/not configured — spotify/i);

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "cid" },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "csec" },
    });
    // Two "Save" buttons now (Spotify + Gemini); the Spotify form is first in the DOM.
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]!);

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

  it("saves a Gemini key and prompts to restart", async () => {
    renderSettings();
    await screen.findByText(/roadie uses the built-in prompt templates/i);

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "gkey-123" },
    });
    // The Gemini form is the second one; its Save is the last matching button.
    const saves = screen.getAllByRole("button", { name: /save/i });
    fireEvent.click(saves[saves.length - 1]!);

    await waitFor(() =>
      expect(api.saveGeminiSettings).toHaveBeenCalledWith("gkey-123"),
    );
    await screen.findByText(/restart marquee/i);
  });
});
