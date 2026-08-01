// The ⌘K overlay (curator-ui-ux §9.1, ADR 0043). Ranking is covered in `commandPalette.test.ts`;
// this covers the surface: what it fetches, what the keyboard does to the selection, and that it
// never shows an empty box without saying why.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AlbumSummary } from "../api";

vi.mock("../api", () => ({ api: { albums: vi.fn() } }));

import { api } from "../api";
import { CommandPalette } from "./CommandPalette";

const summary = (
  curatorId: string,
  title: string,
  artist: string,
): AlbumSummary => ({
  curatorId,
  title,
  artist,
  source: "spotify",
  state: "awaiting_review",
  artwork: null,
  paletteColors: 5,
  hasVideo: false,
});

const ALBUMS = [
  summary("aaaa1111", "Rumours", "Fleetwood Mac"),
  summary("bbbb2222", "Blue", "Joni Mitchell"),
];

const onClose = vi.fn();

const renderPalette = (open = true) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={<CommandPalette open={open} onClose={onClose} />}
        />
        <Route path="/albums/:curatorId" element={<div>album page</div>} />
        <Route path="/settings" element={<div>settings page</div>} />
      </Routes>
    </MemoryRouter>,
  );

const input = () => screen.getByRole("combobox");
const options = () => screen.getAllByRole("option");
const activeOption = () =>
  options().find((o) => o.getAttribute("aria-selected") === "true");

beforeEach(() => {
  onClose.mockReset();
  vi.mocked(api.albums).mockResolvedValue({ albums: ALBUMS });
});
afterEach(cleanup);

describe("CommandPalette", () => {
  it("renders nothing while closed, and doesn't fetch the library", () => {
    renderPalette(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.albums).not.toHaveBeenCalled();
  });

  it("opens focused on the input, so ⌘K is immediately followed by typing", async () => {
    renderPalette();
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("lists the commands before anything is typed, not the whole library", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    const labels = options().map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Settings"))).toBe(true);
    expect(labels.some((l) => l?.includes("Rumours"))).toBe(false);
  });

  it("finds an album by title, fuzzily", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "rmr" } });
    await waitFor(() => expect(options()[0]?.textContent).toContain("Rumours"));
  });

  it("finds an album by artist", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "joni" } });
    await waitFor(() => expect(options()[0]?.textContent).toContain("Blue"));
  });

  it("moves the selection with the arrow keys and opens it with Enter", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "e" } });
    await waitFor(() => expect(options().length).toBeGreaterThan(1));

    expect(activeOption()).toBe(options()[0]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(activeOption()).toBe(options()[1]);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(activeOption()).toBe(options()[0]);

    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText(/album page|settings page/);
    expect(onClose).toHaveBeenCalled();
  });

  it("clamps the selection when a keystroke shrinks the list under it", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "e" } });
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    // A narrower query leaves fewer rows than the cursor's index — Enter must still open a row.
    fireEvent.change(input(), { target: { value: "rumours" } });
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(activeOption()).toBe(options()[0]);
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("album page");
  });

  it("opens a row on click, so the palette is not keyboard-only", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "rumours" } });
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.click(options()[0]!);
    await screen.findByText("album page");
  });

  it("runs a command as well as jumping to an album", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "preferences" } });
    await waitFor(() =>
      expect(options()[0]?.textContent).toContain("Settings"),
    );
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("settings page");
  });

  it("closes on Escape, and on a second ⌘K", async () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input(), { key: "k", metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes when the scrim behind it is clicked", () => {
    const { container } = renderPalette();
    fireEvent.click(container.querySelector(".command-palette-scrim")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("says nothing matched rather than showing an empty box", async () => {
    renderPalette();
    await waitFor(() => expect(api.albums).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "zzzzz" } });
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  });

  it("keeps working, and says why, when the library fetch fails", async () => {
    vi.mocked(api.albums).mockRejectedValue(new Error("curator is down"));
    renderPalette();
    expect(await screen.findByText(/curator is down/)).toBeTruthy();
    // The commands don't come from the server, so they must still be there.
    expect(options().length).toBeGreaterThan(0);
  });
});
