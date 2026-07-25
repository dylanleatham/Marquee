// Listening room + service reachability in Settings (issue #101). The property worth pinning down is
// the rollback: curator-spec §10 says a failed push is rolled back and the user sees a clear error —
// a dropdown left showing a room that didn't save is worse than a slow one.
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
    demoStatus: vi.fn(),
    demoRooms: vi.fn(),
    demoSetRoom: vi.fn(),
    serviceHealth: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

import { api } from "../api";
import { RoomAndServices } from "./RoomAndServices";

const rooms = [
  { id: "1", name: "Living", type: "Room", lightIds: ["11", "12"] },
  { id: "7", name: "Study", type: "Room", lightIds: ["71"] },
];

const select = () =>
  screen.getByLabelText("listening room") as HTMLSelectElement;

beforeEach(() => {
  vi.mocked(api.demoStatus).mockResolvedValue({
    reachable: true,
    paired: true,
    listeningRoomId: "1",
  });
  vi.mocked(api.demoRooms).mockResolvedValue({ rooms });
  vi.mocked(api.demoSetRoom).mockResolvedValue({ listeningRoomId: "7" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("listening room", () => {
  it("shows the current room selected", async () => {
    render(<RoomAndServices />);
    await waitFor(() => expect(select().value).toBe("1"));
    expect(screen.getByText("Living (2 lights)")).toBeTruthy();
  });

  it("pushes a new room to Conductor", async () => {
    render(<RoomAndServices />);
    await waitFor(() => expect(select().value).toBe("1"));

    fireEvent.change(select(), { target: { value: "7" } });

    await waitFor(() => expect(api.demoSetRoom).toHaveBeenCalledWith("7"));
  });

  // curator-spec §10: the change is rolled back on a failed push, with a clear error.
  it("rolls the selection back and explains when the push fails", async () => {
    vi.mocked(api.demoSetRoom).mockRejectedValue(new Error("Conductor down"));
    render(<RoomAndServices />);
    await waitFor(() => expect(select().value).toBe("1"));

    fireEvent.change(select(), { target: { value: "7" } });

    expect(
      await screen.findByText(/Couldn't set the listening room/),
    ).toBeTruthy();
    expect(select().value).toBe("1"); // not left showing a room that didn't save
  });

  it("says so when Conductor is unreachable rather than showing an empty dropdown", async () => {
    vi.mocked(api.demoStatus).mockResolvedValue({
      reachable: false,
      paired: false,
      listeningRoomId: null,
    });
    render(<RoomAndServices />);

    expect(await screen.findByText(/Conductor isn't reachable/)).toBeTruthy();
    expect(screen.queryByLabelText("listening room")).toBeNull();
    expect(api.demoRooms).not.toHaveBeenCalled();
  });

  it("distinguishes 'reachable but no rooms' from 'unreachable'", async () => {
    vi.mocked(api.demoRooms).mockResolvedValue({ rooms: [] });
    render(<RoomAndServices />);

    expect(await screen.findByText(/reports no rooms/)).toBeTruthy();
  });
});

describe("service health", () => {
  it("tests connections on demand and reports each service", async () => {
    vi.mocked(api.serviceHealth).mockResolvedValue({
      services: [
        {
          service: "conductor",
          configured: true,
          reachable: true,
          url: "http://c",
        },
        {
          service: "backdrop",
          configured: true,
          reachable: false,
          url: "http://b",
          detail: "HTTP 503",
        },
        { service: "amp", configured: false, reachable: false },
      ],
    });
    render(<RoomAndServices />);

    fireEvent.click(screen.getByText("Test connections"));

    // Three outcomes, three distinct words — never colour alone (curator-ui-ux §3.4).
    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
  });

  it("shows nothing until asked — probing three services is an explicit action", () => {
    render(<RoomAndServices />);
    expect(screen.queryByText("Reachable")).toBeNull();
    expect(api.serviceHealth).not.toHaveBeenCalled();
  });

  it("explains where URLs and secrets actually live", () => {
    render(<RoomAndServices />);
    expect(screen.getByText(/config\.toml/)).toBeTruthy();
  });
});
