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
    spotifyAuthStatus: vi.fn(),
    spotifyLogin: vi.fn(),
    spotifyDisconnect: vi.fn(),
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
  vi.mocked(api.spotifyAuthStatus).mockResolvedValue({ connected: false });
  vi.mocked(api.spotifyLogin).mockResolvedValue({
    authorizeUrl: "https://accounts.spotify.com/authorize?x=1",
  });
  vi.mocked(api.spotifyDisconnect).mockResolvedValue({ ok: true });
  vi.mocked(api.geminiSettings).mockResolvedValue({
    configured: false,
    generateCardArt: false,
    generateVideo: false,
  });
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
      expect(api.saveGeminiSettings).toHaveBeenCalledWith({
        apiKey: "gkey-123",
      }),
    );
    await screen.findByText(/restart marquee/i);
  });

  it("toggles a generation flag on (persists without re-entering the key)", async () => {
    vi.mocked(api.geminiSettings).mockResolvedValue({
      configured: true,
      generateCardArt: false,
      generateVideo: false,
    });
    renderSettings();
    const cardArt = await screen.findByLabelText(/Auto-generate card art/i);
    fireEvent.click(cardArt);
    await waitFor(() =>
      expect(api.saveGeminiSettings).toHaveBeenCalledWith({
        generateCardArt: true,
      }),
    );
  });

  it("disables the generation toggles until a key is configured", async () => {
    renderSettings();
    const video = await screen.findByLabelText(/Auto-generate visualizer/i);
    expect((video as HTMLInputElement).disabled).toBe(true);
  });

  it("Connect Spotify is disabled until creds are configured", async () => {
    renderSettings();
    const connect = await screen.findByRole("button", {
      name: /connect spotify/i,
    });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the authorize URL when Connect Spotify is clicked", async () => {
    vi.mocked(api.spotifySettings).mockResolvedValue({
      configured: true,
      clientId: "cid12345",
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderSettings();
    const connect = await screen.findByRole("button", {
      name: /connect spotify/i,
    });
    fireEvent.click(connect);
    await waitFor(() => expect(api.spotifyLogin).toHaveBeenCalled());
    expect(open).toHaveBeenCalledWith(
      "https://accounts.spotify.com/authorize?x=1",
      "_blank",
      "noopener",
    );
    open.mockRestore();
  });

  it("shows Disconnect when a user is logged in", async () => {
    vi.mocked(api.spotifyAuthStatus).mockResolvedValue({
      connected: true,
      scope: "streaming",
    });
    renderSettings();
    await screen.findByText(/logged in to spotify/i);
    const disconnect = screen.getByRole("button", { name: /disconnect/i });
    fireEvent.click(disconnect);
    await waitFor(() => expect(api.spotifyDisconnect).toHaveBeenCalled());
  });
});
