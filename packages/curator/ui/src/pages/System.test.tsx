// System (ADR 0052) — the page you open when something is wrong, and the one place a raw error code
// belongs.
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
    systemStatus: vi.fn(),
    runtimeSync: vi.fn().mockResolvedValue({}),
    demoStop: vi.fn().mockResolvedValue({ stopped: true }),
  },
}));

import { api, type SystemStatus as Status } from "../api";
import { System } from "./System";

const status = (over: Partial<Status> = {}): Status =>
  ({
    at: "2026-08-06T18:40:00.000Z",
    services: [
      {
        service: "conductor",
        configured: true,
        reachable: true,
        url: "http://localhost:4741",
      },
      {
        service: "backdrop",
        configured: true,
        reachable: true,
        url: "http://localhost:4740",
      },
      {
        service: "stylus",
        configured: true,
        reachable: false,
        url: "http://stylus.local:4742",
        detail: "connect ECONNREFUSED",
      },
      { service: "amp", configured: false, reachable: false },
    ],
    playing: {
      video: null,
      lights: [
        { roomId: "7", source: { name: "Rumours" }, pattern: "crossfade" },
      ],
      audio: null,
      caveats: ["Streaming patterns report nothing."],
    },
    stylus: null,
    albums: [],
    jobs: [],
    ...over,
  }) as Status;

const show = () =>
  render(
    <MemoryRouter>
      <System />
    </MemoryRouter>,
  );

// Implementations are restored, not just cleared: `clearAllMocks` keeps them, so one test's
// rejection would otherwise leak into every test after it.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.systemStatus).mockResolvedValue(status());
  vi.mocked(api.demoStop).mockResolvedValue({ stopped: true });
  vi.mocked(api.runtimeSync).mockResolvedValue({
    id: "sync1",
    kind: "runtimeSync",
    status: "running",
    progress: { done: 0, total: 13 },
    createdAt: "",
    updatedAt: "",
  });
});
afterEach(cleanup);

describe("System — the services", () => {
  it("says what each service is for, not just its name", async () => {
    show();
    expect(await screen.findByText("the lights")).toBeTruthy();
    expect(screen.getByText("the screen")).toBeTruthy();
    expect(screen.getByText("the sound — not set up")).toBeTruthy();
  });

  it("shows the raw code for a failing service — the one place that belongs", async () => {
    // `connect ECONNREFUSED` is the actionable text; paraphrasing takes away the thing you paste
    // into a search.
    show();
    expect(await screen.findByText("connect ECONNREFUSED")).toBeTruthy();
    expect(screen.getByText("the stand — not answering")).toBeTruthy();
    expect(screen.getByRole("button", { name: "RETRY" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "COPY ERROR" })).toBeTruthy();
  });

  it("keeps 'not set up' visually apart from 'not answering'", async () => {
    show();
    await screen.findByText("connect ECONNREFUSED");
    expect(document.querySelectorAll(".svc--down")).toHaveLength(1);
    expect(document.querySelectorAll(".svc--unset")).toHaveLength(1);
  });
});

describe("System — what is happening", () => {
  it("shows in-flight jobs with a count as well as a bar", async () => {
    vi.mocked(api.systemStatus).mockResolvedValue(
      status({
        jobs: [
          {
            id: "j1",
            kind: "runtimeSync",
            status: "running",
            progress: { done: 3, total: 13 },
            createdAt: "",
            updatedAt: "",
          },
          {
            id: "j2",
            kind: "mediaTransfer",
            curatorId: "abc12345",
            status: "running",
            progress: { done: 68, total: 100 },
            createdAt: "",
            updatedAt: "",
          },
        ],
      }),
    );
    show();
    expect(await screen.findByText("IN FLIGHT · 2")).toBeTruthy();
    expect(screen.getByText("3/13")).toBeTruthy();
    expect(screen.getByText("68%")).toBeTruthy();
    expect(screen.getByText("media-sync")).toBeTruthy();
  });

  it("says what is playing, and admits when it can't tell", async () => {
    show();
    // The record, not the room: under "playing right now" that is the answer, and for an album with
    // no visualizer it is the only line that names it.
    expect(await screen.findByText("Rumours, crossfade")).toBeTruthy();
    expect(screen.getByText(/can't tell — Stylus is down/)).toBeTruthy();
    // The limits are stated rather than implied by a confident blank.
    expect(screen.getByText(/Streaming patterns report nothing/)).toBeTruthy();
  });
});

describe("System — stopping the lights (ADR 0061)", () => {
  const stopButton = () =>
    screen.findByRole("button", { name: /STOP THE LIGHTS/ });

  it("stops the lights from the row that says they are on", async () => {
    show();
    fireEvent.click(await stopButton());
    await waitFor(() => expect(api.demoStop).toHaveBeenCalled());
  });

  it("says the lights are off, because the row alone may not change", async () => {
    // The caveat in the same section says the playback view misses streaming patterns, so a stop
    // can be entirely correct and leave every row reading exactly as it did.
    show();
    fireEvent.click(await stopButton());
    expect(
      await screen.findByText(/The lights are off — the room is back/),
    ).toBeTruthy();
  });

  it("offers the stop even when it can't see anything playing", async () => {
    vi.mocked(api.systemStatus).mockResolvedValue(
      status({
        playing: {
          video: null,
          lights: [],
          audio: null,
          caveats: ["Streaming patterns report nothing."],
        },
      }),
    );
    show();
    // Gating on `lights` would hide the control in the one case the page admits it is blind to.
    expect(await stopButton()).toBeTruthy();
  });

  it("hides the stop when Conductor isn't answering — it could only 502", async () => {
    vi.mocked(api.systemStatus).mockResolvedValue(
      status({
        services: [
          {
            service: "conductor",
            configured: true,
            reachable: false,
            url: "http://localhost:4741",
            detail: "connect ECONNREFUSED",
          },
        ],
      }),
    );
    show();
    await screen.findByText("the lights — not answering");
    expect(
      screen.queryByRole("button", { name: /STOP THE LIGHTS/ }),
    ).toBeNull();
  });

  it("says so when the stop fails, rather than settling back in silence", async () => {
    vi.mocked(api.demoStop).mockRejectedValue(
      new Error("no room specified and no listening room configured"),
    );
    show();
    fireEvent.click(await stopButton());
    expect(
      await screen.findByText(/Couldn't stop the lights: no room specified/),
    ).toBeTruthy();
  });
});

describe("System — the exceptions", () => {
  it("lists only records that aren't where they should be", async () => {
    vi.mocked(api.systemStatus).mockResolvedValue(
      status({
        albums: [
          {
            curatorId: "ok",
            name: "Blue",
            artist: "Joni Mitchell",
            hasVideo: false,
            onConductor: true,
            inBackdropLibrary: false,
            videoOnBackdrop: false,
          },
          {
            curatorId: "bad",
            name: "Purple Rain",
            artist: "Prince",
            hasVideo: false,
            onConductor: false,
            inBackdropLibrary: false,
            videoOnBackdrop: false,
          },
        ],
      }),
    );
    show();
    expect(await screen.findByText("NOT ON CONDUCTOR")).toBeTruthy();
    // A record with no visualizer belongs on Conductor and nowhere else, so it isn't a problem.
    expect(screen.queryByText("Blue")).toBeNull();
  });

  it("says so plainly when there is nothing wrong", async () => {
    show();
    expect(
      await screen.findByText("Every record is everywhere it should be."),
    ).toBeTruthy();
  });

  it("has no album matrix", async () => {
    show();
    await screen.findByText("the lights");
    expect(document.querySelector("table")).toBeNull();
  });
});

describe("System — states it owes", () => {
  it("reports a failed read rather than showing a blank page", async () => {
    vi.mocked(api.systemStatus).mockRejectedValue(new Error("nope"));
    show();
    expect(await screen.findByText(/Couldn't read the system/)).toBeTruthy();
  });

  it("pushes everything on demand", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /SYNC EVERYTHING/ }),
    );
    await waitFor(() => expect(api.runtimeSync).toHaveBeenCalled());
  });

  it("says so when the sync itself fails — on this page least of all may it be silent", async () => {
    vi.mocked(api.runtimeSync).mockRejectedValue(
      new Error("Conductor is down"),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /SYNC EVERYTHING/ }),
    );
    expect(
      await screen.findByText(/Couldn't sync: Conductor is down/),
    ).toBeTruthy();
  });
});
