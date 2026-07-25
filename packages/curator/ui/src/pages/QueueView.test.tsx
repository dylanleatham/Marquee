// The queue's keyboard path (curator-ui-ux §9.1). The success criterion is working through ten
// albums in one session — j/k/Enter is what makes that a session rather than ten round-trips to the
// mouse. Every shortcut here is also a click; these lock in that it never steals a keystroke from a
// field the user is typing into.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { QueueGroups } from "../api";

vi.mock("../api", () => ({
  api: { queue: vi.fn() },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));

import { api } from "../api";
import { QueueView } from "./QueueView";

const entry = (curatorId: string, title: string) => ({
  curatorId,
  title,
  artist: "Prince",
  artwork: null,
  state: "awaiting_review" as const,
  subState: null,
  enteredStateAt: "2026-07-25T00:00:00Z",
  lastError: null,
  flags: {},
});

const groups = (): QueueGroups =>
  ({
    awaiting_review: [entry("aaaa1111", "One"), entry("bbbb2222", "Two")],
    awaiting_video: [entry("cccc3333", "Three")],
    awaiting_preview: [],
    awaiting_tag_write: [],
    awaiting_verify: [],
    processing: [],
    errored: [],
    needs_manual: [],
    done_recently: [],
  }) as unknown as QueueGroups;

const renderQueue = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<QueueView />} />
        <Route path="/albums/:curatorId" element={<div>detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );

const selectedTitle = () =>
  document.querySelector(".row--selected .row__title")?.textContent ?? null;

describe("QueueView keyboard navigation", () => {
  beforeEach(() => {
    vi.mocked(api.queue).mockResolvedValue(groups());
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects the first row once the queue loads", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
  });

  it("moves the selection with j and k, across section boundaries", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));

    // "Three" lives in a different section — the flattened order reads the way the page does.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
  });

  it("clamps at both ends rather than wrapping", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    for (let i = 0; i < 6; i++) fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));
  });

  it("opens the selected album on Enter", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Two"));
    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByText("detail page")).toBeTruthy();
  });

  it("focuses search on /", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));

    fireEvent.keyDown(window, { key: "/" });

    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/Search title or artist/),
    );
  });

  // The rule that keeps a shortcut from eating a search query.
  it("never hijacks a keystroke aimed at a field", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    const search = screen.getByPlaceholderText(/Search title or artist/);

    fireEvent.keyDown(search, { key: "j" });

    expect(selectedTitle()).toBe("One"); // selection did not move
  });

  it("blurs the search field on Escape instead of navigating", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    const search = screen.getByPlaceholderText(
      /Search title or artist/,
    ) as HTMLInputElement;
    search.focus();

    fireEvent.keyDown(search, { key: "Escape" });

    expect(document.activeElement).not.toBe(search);
  });

  it("keeps a valid selection when filtering shrinks the list", async () => {
    renderQueue();
    await waitFor(() => expect(selectedTitle()).toBe("One"));
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selectedTitle()).toBe("Three"));

    fireEvent.change(screen.getByPlaceholderText(/Search title or artist/), {
      target: { value: "One" },
    });

    // The cursor was past the end of the filtered list; it clamps rather than selecting nothing.
    await waitFor(() => expect(selectedTitle()).toBe("One"));
  });
});
