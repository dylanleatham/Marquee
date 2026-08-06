// The ready toast (ADR 0052) — what the "record finished" screen became.
//
// The properties that matter are the ones a screen didn't have: it goes away on its own, and it
// never stands between you and the next record.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AlbumSummary } from "../api";
import { ReadyToast } from "./ReadyToast";
import {
  showReadyToast,
  dismissReadyToast,
  readyToastSnapshot,
} from "../readyToast";

const ALBUMS = [
  {
    curatorId: "abc12345",
    title: "Purple Rain",
    artwork: "media/artwork/abc12345.jpg",
  },
] as AlbumSummary[];

const show = (albums: AlbumSummary[] | null = ALBUMS) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <p>the collection</p>
              <ReadyToast albums={albums} />
            </>
          }
        />
        <Route path="/room/:curatorId" element={<p>the room</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  dismissReadyToast();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ReadyToast", () => {
  it("shows nothing until a record is signed off", () => {
    show();
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it("names the record and says what was finished", () => {
    show();
    act(() => showReadyToast("abc12345"));
    expect(screen.getByText("Purple Rain is ready")).toBeTruthy();
    expect(
      screen.getByText(/Lights, visualizer, card and tags — all done/),
    ).toBeTruthy();
  });

  it("is one button, and opens the room for that record", () => {
    show();
    act(() => showReadyToast("abc12345"));
    fireEvent.click(
      screen.getByRole("button", { name: /Purple Rain is ready/ }),
    );
    expect(screen.getByText("the room")).toBeTruthy();
  });

  it("cancels its own timer when tapped, so it can't fade over the screen it opened", () => {
    show();
    act(() => showReadyToast("abc12345"));
    fireEvent.click(
      screen.getByRole("button", { name: /Purple Rain is ready/ }),
    );
    expect(readyToastSnapshot()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(readyToastSnapshot()).toBeNull();
  });

  it("goes away on its own — it must not need dismissing", () => {
    show();
    act(() => showReadyToast("abc12345"));
    expect(screen.getByText("Purple Rain is ready")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it("restarts the clock when a second record lands on top of the first", () => {
    show();
    act(() => showReadyToast("abc12345"));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    act(() => showReadyToast("abc12345"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Would already be gone on the first timer; the second press replaced it.
    expect(screen.getByText("Purple Rain is ready")).toBeTruthy();
  });

  it("stays silent rather than saying 'Untitled is ready'", () => {
    // Better nothing than a celebration that can't name what it is celebrating.
    show([]);
    act(() => showReadyToast("abc12345"));
    expect(screen.queryByText(/is ready/)).toBeNull();
  });
});
