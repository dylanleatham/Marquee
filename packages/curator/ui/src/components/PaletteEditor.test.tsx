import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { PaletteEditor } from "./PaletteEditor";
import { api, type AlbumAsset } from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = async (fn: () => Promise<unknown>) => {
  await fn();
};

const input = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;
const select = (label: string) =>
  screen.getByLabelText(label) as HTMLSelectElement;
const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

const baseAsset = (patch: Partial<AlbumAsset> = {}): AlbumAsset => ({
  curatorId: "aaaa1111",
  createdAt: "2026-07-11T00:00:00Z",
  metadata: { name: "N", artist: "A", source: "manual" },
  palette: {
    colors: [
      { hex: "#4B0082", role: "primary" },
      { hex: "#FFD700", role: "secondary" },
    ],
    generatedAt: "2026-07-11T00:00:00Z",
    handEdited: false,
  },
  pattern: { type: "crossfade", params: {} },
  roadie: {
    state: "awaiting_review",
    subState: null,
    flags: {
      palette_insufficient: false,
      album_not_on_spotify: false,
      art_override_active: false,
    },
    history: [],
    lastError: null,
    retryCount: 0,
  },
  status: { highLevel: "awaiting_review", next: null, issues: [] },
  ...patch,
});

const editor = (patch?: Partial<AlbumAsset>) => (
  <PaletteEditor
    curatorId="aaaa1111"
    asset={baseAsset(patch)}
    run={run}
    busy={false}
  />
);

describe("PaletteEditor", () => {
  it("renders a row per color with the hex value", () => {
    render(editor());
    expect(input("Color 1 hex").value).toBe("#4B0082");
    expect(input("Color 2 hex").value).toBe("#FFD700");
    expect(screen.getByText("dominant")).toBeTruthy();
  });

  it("keeps Save disabled until an edit, then PUTs the palette", async () => {
    const spy = vi.spyOn(api, "editPalette").mockResolvedValue({} as never);
    render(editor());
    expect(button("Save palette").disabled).toBe(true);

    fireEvent.change(input("Color 1 hex"), { target: { value: "#000000" } });
    expect(button("Save palette").disabled).toBe(false);

    fireEvent.click(button("Save palette"));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("aaaa1111", [
        { hex: "#000000", role: "primary" },
        { hex: "#FFD700", role: "secondary" },
      ]),
    );
    // baseline re-synced after save → Save disabled again
    await waitFor(() => expect(button("Save palette").disabled).toBe(true));
  });

  it("reorder promotes a color to dominant and re-derives roles by position", () => {
    render(editor());
    fireEvent.click(screen.getByLabelText("Move color 2 up"));
    expect(input("Color 1 hex").value).toBe("#FFD700");
    expect(select("Color 1 role").value).toBe("primary");
    expect(select("Color 2 role").value).toBe("secondary");
  });

  it("adds and removes color rows within the 1..8 bounds", () => {
    render(editor());
    fireEvent.click(button("+ Color"));
    expect(screen.queryByLabelText("Color 3 hex")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Remove color 3"));
    expect(screen.queryByLabelText("Color 3 hex")).toBeNull();
  });

  it("Reset to auto re-extracts, forcing over a hand-edited palette after confirm", async () => {
    const spy = vi
      .spyOn(api, "regeneratePalette")
      .mockResolvedValue({} as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      editor({
        palette: {
          colors: [{ hex: "#4B0082", role: "primary" }],
          generatedAt: "2026-07-11T00:00:00Z",
          handEdited: true,
        },
      }),
    );
    fireEvent.click(button("Reset to auto"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("aaaa1111", true));
  });

  it("disables Reset to auto while there are unsaved edits", () => {
    render(editor());
    fireEvent.change(input("Color 1 hex"), { target: { value: "#000000" } });
    expect(button("Reset to auto").disabled).toBe(true);
  });
});
