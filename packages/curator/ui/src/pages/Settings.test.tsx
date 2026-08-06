// Settings (ADR 0052) — permissions, not feature flags, and honest about what it cannot change.
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
    serviceHealth: vi.fn().mockResolvedValue({
      services: [
        {
          service: "conductor",
          configured: true,
          reachable: true,
          url: "http://conductor.local:4741",
        },
        {
          service: "backdrop",
          configured: true,
          reachable: true,
          url: "http://backdrop.local:4740",
        },
        {
          service: "stylus",
          configured: true,
          reachable: true,
          url: "http://stylus.local:4742",
        },
        { service: "amp", configured: false, reachable: false },
      ],
    }),
    demoStatus: vi.fn().mockResolvedValue({
      reachable: true,
      paired: true,
      listeningRoomId: "7",
    }),
    demoRooms: vi
      .fn()
      .mockResolvedValue({ rooms: [{ id: "7", name: "Living Room" }] }),
    demoSetRoom: vi.fn().mockResolvedValue({ listeningRoomId: "7" }),
    spotifySettings: vi
      .fn()
      .mockResolvedValue({ configured: true, clientId: "abc" }),
    spotifyAuthStatus: vi.fn().mockResolvedValue({ connected: true }),
    spotifyLogin: vi.fn(),
    spotifyDisconnect: vi.fn().mockResolvedValue({ ok: true }),
    saveSpotifySettings: vi.fn().mockResolvedValue({ restartRequired: true }),
    geminiSettings: vi.fn().mockResolvedValue({
      configured: true,
      generateCardArt: true,
      generateVideo: false,
    }),
    saveGeminiSettings: vi.fn().mockResolvedValue({ restartRequired: true }),
    discogsSettings: vi.fn().mockResolvedValue({
      configured: true,
      oauthConfigured: false,
      username: "dylan",
      autoSync: true,
      autoSyncIntervalMinutes: 1440,
    }),
    saveDiscogsSettings: vi.fn().mockResolvedValue({ restartRequired: false }),
    discogsAuthStatus: vi.fn().mockResolvedValue({ connected: false }),
    discogsLogin: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: "https://discogs.test/authorize" }),
    discogsDisconnect: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import { api } from "../api";
import { Settings, syncCadence } from "./Settings";

describe("syncCadence", () => {
  it("says the configured interval, so a changed one isn't described as daily", () => {
    expect(syncCadence(1440)).toBe("Checks once a day");
    expect(syncCadence(undefined)).toBe("Checks once a day");
    expect(syncCadence(60)).toBe("Checks every hour");
    expect(syncCadence(180)).toBe("Checks every 3 hours");
    expect(syncCadence(30)).toBe("Checks every 30 minutes");
  });
});

/**
 * Restored before every test, not just cleared: `clearAllMocks` drops recorded calls but keeps the
 * implementation, so a test that makes Conductor unreachable leaves it unreachable for everything
 * that follows — which is how two tests here passed against the wrong branch.
 */
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.demoStatus).mockResolvedValue({
    reachable: true,
    paired: true,
    listeningRoomId: "7",
  });
  vi.mocked(api.demoRooms).mockResolvedValue({
    rooms: [{ id: "7", name: "Living Room", type: "room", lightIds: ["1"] }],
  });
  vi.mocked(api.demoSetRoom).mockResolvedValue({ listeningRoomId: "7" });
  vi.mocked(api.discogsSettings).mockResolvedValue({
    configured: true,
    oauthConfigured: false,
    username: "dylan",
    autoSync: true,
    autoSyncIntervalMinutes: 1440,
  });
  vi.mocked(api.discogsAuthStatus).mockResolvedValue({ connected: false });
  vi.mocked(api.discogsLogin).mockResolvedValue({
    authorizeUrl: "https://discogs.test/authorize",
  });
  vi.mocked(api.spotifyAuthStatus).mockResolvedValue({ connected: true });
});
afterEach(cleanup);

describe("Settings — the room and the services", () => {
  it("lets you choose which room the lights are in", async () => {
    render(<Settings />);
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "7" } });
    await waitFor(() => expect(api.demoSetRoom).toHaveBeenCalledWith("7"));
  });

  it("says the rooms can't be listed when Conductor is down, instead of an empty picker", async () => {
    vi.mocked(api.demoStatus).mockResolvedValue({
      reachable: false,
      paired: false,
      listeningRoomId: null,
    });
    render(<Settings />);
    expect(await screen.findByText(/Conductor isn't answering/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says so and keeps the old room when Conductor refuses the change", async () => {
    // The select reads its value from the poll rather than from local state, so a refused push
    // leaves the previous room selected on its own — curator-spec §10's rollback, for free. What it
    // must not do is fail quietly.
    vi.mocked(api.demoSetRoom).mockRejectedValue(new Error("bridge is down"));
    vi.mocked(api.demoRooms).mockResolvedValue({
      rooms: [
        { id: "7", name: "Living Room", type: "room", lightIds: ["1"] },
        { id: "8", name: "Kitchen", type: "room", lightIds: ["2"] },
      ],
    });
    render(<Settings />);
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "8" } });
    expect(await screen.findByText(/bridge is down/)).toBeTruthy();
    expect(select.value).toBe("7");
  });

  it("says Conductor has no rooms rather than showing an empty picker", async () => {
    vi.mocked(api.demoRooms).mockResolvedValue({ rooms: [] });
    render(<Settings />);
    expect(await screen.findByText(/pair a Hue bridge/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the service addresses and where they are actually set", async () => {
    // They are resolved once at boot from config.toml or the environment, and settings.json sits
    // *below* config.toml in that chain — so an editable box here could be silently overridden.
    // Showing the value and saying where it comes from beats a field that does nothing.
    render(<Settings />);
    expect(await screen.findByText("http://conductor.local:4741")).toBeTruthy();
    expect(screen.getByText(/not set — the sound is off/)).toBeTruthy();
    expect(screen.getByText(/read once at startup/)).toBeTruthy();
  });
});

describe("Settings — accounts", () => {
  it("says which are connected, in words next to the dot", async () => {
    render(<Settings />);
    expect(await screen.findByText(/Spotify — signed in/)).toBeTruthy();
    expect(screen.getByText(/Gemini — connected/)).toBeTruthy();
    expect(screen.getByText(/Discogs — as dylan/)).toBeTruthy();
  });

  it("still calls an account connected when its token works but nobody is signed in", async () => {
    // A personal token / app credentials are enough to use either service; only a *user session* is
    // missing. Written with `??` this read "not connected" the moment auth answered `false`, which
    // is a working account reported as broken.
    vi.mocked(api.spotifyAuthStatus).mockResolvedValue({ connected: false });
    vi.mocked(api.discogsAuthStatus).mockResolvedValue({ connected: false });
    render(<Settings />);
    expect(await screen.findByText(/Spotify — connected/)).toBeTruthy();
    expect(screen.getByText(/Discogs — as dylan/)).toBeTruthy();
  });

  it("keeps the credential fields behind CHANGE", async () => {
    render(<Settings />);
    const change = (
      await screen.findAllByRole("button", { name: "CHANGE" })
    )[0]!;
    expect(screen.queryByText("CLIENT SECRET")).toBeNull();
    fireEvent.click(change);
    expect(screen.getByText("CLIENT SECRET")).toBeTruthy();
  });

  it("says a secret has to be typed again, because it is never sent back", async () => {
    render(<Settings />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "CHANGE" }))[0]!,
    );
    expect(
      screen.getAllByPlaceholderText(/never sent back/).length,
    ).toBeGreaterThan(0);
  });

  it("offers the Discogs login when its consumer creds are set up", async () => {
    // A personal token is the simple default, but the OAuth login exists (ADR 0017) and its routes
    // are live — an account you can only connect by curl is one nobody connects.
    vi.mocked(api.discogsSettings).mockResolvedValue({
      configured: true,
      oauthConfigured: true,
      username: "dylan",
      autoSync: true,
      autoSyncIntervalMinutes: 1440,
    });
    render(<Settings />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "CHANGE" }))[2]!,
    );
    const open = vi.fn();
    vi.stubGlobal("open", open);
    fireEvent.click(
      screen.getByRole("button", { name: "SIGN IN WITH DISCOGS" }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://discogs.test/authorize",
        "_blank",
      ),
    );
    vi.unstubAllGlobals();
  });

  it("says so when a sign-in won't start", async () => {
    vi.mocked(api.discogsSettings).mockResolvedValue({
      configured: true,
      oauthConfigured: true,
      username: "dylan",
      autoSync: true,
      autoSyncIntervalMinutes: 1440,
    });
    vi.mocked(api.discogsLogin).mockRejectedValue(new Error("no consumer key"));
    render(<Settings />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "CHANGE" }))[2]!,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "SIGN IN WITH DISCOGS" }),
    );
    expect(await screen.findByText(/no consumer key/)).toBeTruthy();
  });

  it("hides the Discogs login when there are no consumer creds to log in with", async () => {
    vi.mocked(api.discogsSettings).mockResolvedValue({
      configured: true,
      oauthConfigured: false,
      username: "dylan",
      autoSync: true,
      autoSyncIntervalMinutes: 1440,
    });
    render(<Settings />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "CHANGE" }))[2]!,
    );
    expect(
      screen.queryByRole("button", { name: /SIGN IN WITH DISCOGS/ }),
    ).toBeNull();
  });

  it("says a restart is needed when the server says so", async () => {
    render(<Settings />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "CHANGE" }))[0]!,
    );
    fireEvent.change(screen.getByDisplayValue("abc"), {
      target: { value: "id2" },
    });
    fireEvent.change(screen.getAllByPlaceholderText(/never sent back/)[0]!, {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "SAVE" }));
    await waitFor(() =>
      expect(screen.getByText(/Restart Marquee/)).toBeTruthy(),
    );
  });
});

describe("Settings — what Roadie may do on its own", () => {
  it("shows the three permissions that exist, with their cost", async () => {
    render(<Settings />);
    expect(await screen.findByText("Draw card art")).toBeTruthy();
    expect(screen.getByText(/Cheap — about five images a go/)).toBeTruthy();
    expect(screen.getByText("Make the visualizers")).toBeTruthy();
    expect(screen.getByText(/Metered and pricey/)).toBeTruthy();
    expect(screen.getByText("Follow my Discogs collection")).toBeTruthy();
  });

  it("reflects and flips each one", async () => {
    render(<Settings />);
    const box = (name: RegExp) =>
      screen.getByRole("checkbox", { name }) as HTMLInputElement;
    await screen.findByText("Draw card art");
    expect(box(/Draw card art/).checked).toBe(true);
    expect(box(/Make the visualizers/).checked).toBe(false);

    fireEvent.click(box(/Make the visualizers/));
    await waitFor(() =>
      expect(api.saveGeminiSettings).toHaveBeenCalledWith({
        generateVideo: true,
      }),
    );
    fireEvent.click(box(/Follow my Discogs/));
    await waitFor(() =>
      expect(api.saveDiscogsSettings).toHaveBeenCalledWith({ autoSync: false }),
    );
  });

  it("explains why the second palette is not a permission", async () => {
    // There is no such flag, and adding one would put a paid call in Roadie's pipeline — which
    // ADR 0027 rules out and ADR 0051 depends on. A checkbox that lied would be worse than the note.
    render(<Settings />);
    expect(await screen.findByText(/Suggesting a second palette/)).toBeTruthy();
    expect(screen.getByText(/keeps a whole-collection sync free/)).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: /second palette/ }),
    ).toBeNull();
  });
});
