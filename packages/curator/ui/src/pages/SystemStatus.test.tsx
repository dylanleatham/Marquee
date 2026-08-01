import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SystemStatus } from "./SystemStatus";

vi.mock("../api", () => ({
  api: { systemStatus: vi.fn(), runtimeSync: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { api } from "../api";

const base = {
  at: "2026-08-01T00:00:00.000Z",
  services: [
    {
      service: "conductor",
      configured: true,
      reachable: true,
      url: "http://c",
    },
    { service: "backdrop", configured: true, reachable: true, url: "http://b" },
    { service: "amp", configured: false, reachable: false },
    {
      service: "stylus",
      configured: true,
      reachable: false,
      url: "http://s",
      detail: "ECONNREFUSED",
    },
  ],
  playing: {
    video: { state: "idle", uri: null, filePath: null, browserConnected: true },
    lights: [],
    audio: null,
    caveats: ["Lights show only CLIP playback."],
  },
  stylus: null,
  albums: [],
  jobs: [],
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/system"]}>
      <Routes>
        <Route path="/system" element={<SystemStatus />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(api.systemStatus).mockResolvedValue(base as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SystemStatus", () => {
  it("distinguishes unconfigured from unreachable, in words", async () => {
    renderPage();
    // Amp has no URL; Stylus has one and isn't answering. Two different problems, two different
    // fixes — collapsing them is the bug this page would otherwise inherit.
    expect(await screen.findByText(/Not configured/)).toBeTruthy();
    expect(screen.getByText(/Unreachable/)).toBeTruthy();
    expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy();
  });

  it("says the stand is unreachable rather than implying it is empty", async () => {
    renderPage();
    expect(await screen.findByText(/Stylus isn't reachable/)).toBeTruthy();
  });

  describe("the stand", () => {
    const withStylus = (stylus: unknown) =>
      vi.mocked(api.systemStatus).mockResolvedValue({
        ...base,
        stylus,
      } as never);

    it("reports an empty stand", async () => {
      withStylus({ state: "idle", observed: null, lastBadTag: null });
      renderPage();
      expect(await screen.findByText(/Nothing on the stand/)).toBeTruthy();
    });

    // The case that used to be indistinguishable from an empty stand (stylus-spec §8).
    it("reports a sleeve that is present but won't decode", async () => {
      withStylus({
        state: "idle",
        observed: { uid: "04:A1", uri: null, at: "t" },
        lastBadTag: null,
      });
      renderPage();
      expect(await screen.findByText(/won't decode/)).toBeTruthy();
      expect(screen.getByText(/04:A1/)).toBeTruthy();
    });

    // The tag that looks fine from every angle and still does nothing: it decoded cleanly, so it is
    // neither "nothing there" nor "won't read", but the machine will never act on it.
    it("distinguishes a decoded tag the machine won't act on from a working one", async () => {
      withStylus({
        state: "idle",
        observed: { uid: "04:C3", uri: "spotify:album:nope", at: "t" },
        lastBadTag: null,
      });
      renderPage();
      expect(await screen.findByText(/not a Marquee URI/)).toBeTruthy();
      expect(screen.queryByText(/^Reading /)).toBeNull();
    });

    it("reports what a readable sleeve says", async () => {
      withStylus({
        state: "playing",
        lastUri: "curator:album:aaaa1111",
        observed: { uid: "04:A1", uri: "curator:album:aaaa1111", at: "t" },
        lastBadTag: null,
      });
      renderPage();
      expect(
        await screen.findByText(/Reading curator:album:aaaa1111/),
      ).toBeTruthy();
    });

    it("keeps the last rejection after the sleeve is lifted", async () => {
      withStylus({
        state: "idle",
        observed: null,
        lastBadTag: { uid: "04:B2", uri: null, at: "t" },
      });
      renderPage();
      expect(await screen.findByText(/Nothing on the stand/)).toBeTruthy();
      expect(screen.getByText(/04:B2/)).toBeTruthy();
    });
  });

  describe("the album matrix", () => {
    const albums = [
      {
        curatorId: "aaaa1111",
        name: "Ready One",
        artist: "A",
        hasVideo: true,
        onConductor: true,
        inBackdropLibrary: true,
        videoOnBackdrop: true,
      },
      {
        curatorId: "bbbb2222",
        name: "Missing Video",
        artist: "B",
        hasVideo: true,
        onConductor: true,
        inBackdropLibrary: true,
        videoOnBackdrop: false,
      },
      {
        curatorId: "cccc3333",
        name: "Never Pushed",
        artist: "C",
        hasVideo: true,
        onConductor: false,
        inBackdropLibrary: false,
        videoOnBackdrop: false,
      },
    ];

    beforeEach(() => {
      vi.mocked(api.systemStatus).mockResolvedValue({
        ...base,
        albums,
      } as never);
    });

    it("summarises what is wrong across the library", async () => {
      renderPage();
      // 3 albums; 1 never pushed to Conductor; 2 have a visualizer Backdrop cannot play
      // (bbbb2222's bytes are missing, cccc3333 isn't in the library at all).
      expect(
        await screen.findByText(/3 in Curator · 1 not on Conductor/),
      ).toBeTruthy();
      expect(
        screen.getByText(/2 with a video Backdrop can't play/),
      ).toBeTruthy();
    });

    it("marks each album ready or incomplete, as a word not a colour", async () => {
      renderPage();
      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(screen.getAllByText("Incomplete")).toHaveLength(2);
    });

    // Every cell is a glyph plus screen-reader text; a tick with no accessible name would make the
    // table meaningless to anyone not reading it visually (curator-ui-ux §3.4).
    it("gives every presence cell an accessible explanation", async () => {
      renderPage();
      expect(
        await screen.findByText(/Conductor has never been given this album/),
      ).toBeTruthy();
      // Two albums lack playable bytes, and each cell carries its own explanation.
      expect(
        screen.getAllByText(/Backdrop has no playable file/).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("links each album to its detail page", async () => {
      renderPage();
      const link = await screen.findByText("Ready One");
      expect(link.closest("a")?.getAttribute("href")).toBe("/albums/aaaa1111");
    });
  });

  it("starts a runtime sync and reports the job", async () => {
    vi.mocked(api.runtimeSync).mockResolvedValue({ id: "job-1" } as never);
    renderPage();
    fireEvent.click(await screen.findByText("Sync everything"));
    await waitFor(() => expect(api.runtimeSync).toHaveBeenCalled());
    expect(await screen.findByText(/Sync started \(job job-1\)/)).toBeTruthy();
  });

  it("surfaces a failed sync instead of looking like it worked", async () => {
    vi.mocked(api.runtimeSync).mockRejectedValue(new Error("no runtime"));
    renderPage();
    fireEvent.click(await screen.findByText("Sync everything"));
    expect(await screen.findByText(/Couldn't start the sync/)).toBeTruthy();
  });

  it("states the lights caveat rather than implying the view is complete", async () => {
    renderPage();
    expect(
      await screen.findByText(/Lights show only CLIP playback/),
    ).toBeTruthy();
  });
});

// The page fans out to four services with a 5s bound per probe, on a 5s interval — so when the
// runtime is down, which is when this page is open, a slow request would otherwise have the next
// poll land on top of it and pile up overlapping fan-outs against a host already not answering.
describe("polling", () => {
  it("coalesces a poll that arrives while one is still in flight", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(api.systemStatus).mockReturnValue(
      new Promise((r) => (release = r)) as never,
    );

    renderPage();
    // The mount fetch is outstanding. Nudge the interval; no second request may be issued.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.systemStatus).toHaveBeenCalledTimes(1);

    release(base);
    await waitFor(() => expect(screen.getByText("System status")).toBeTruthy());
  });
});
