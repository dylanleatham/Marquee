// Where the colours come from (ADR 0030 / issue #105). The properties worth pinning are the ones
// that make the control safe: the cover is the default and nothing runs unless asked, proposing
// costs a call but changes nothing, and going *back* to the cover — the only destructive move —
// asks first.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

vi.mock("../api", () => ({
  api: { feelingPalette: vi.fn(), choosePalette: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { api, type AlbumAsset, type PaletteCandidates } from "../api";
import { FeelingPalette } from "./FeelingPalette";
import { ConfirmProvider } from "./Confirm";

const swatch = (hex: string) => ({ hex, role: "primary" });

const candidates: PaletteCandidates = {
  generatedAt: "2026-07-26T00:00:00.000Z",
  rationale: "Nocturnal, smoky, and warmer than its sleeve.",
  cover: [swatch("#101010"), swatch("#202020")],
  feeling: [swatch("#1B2A4A"), swatch("#C2410C")],
  blend: [swatch("#101010"), swatch("#1B2A4A")],
};

const asset = (patch: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "feelalb1",
    palette: { colors: [swatch("#101010")], handEdited: false },
    ...patch,
  }) as unknown as AlbumAsset;

const run = (fn: () => Promise<unknown>) => fn();

const show = (a: AlbumAsset = asset()) =>
  render(
    <ConfirmProvider>
      <FeelingPalette curatorId="feelalb1" asset={a} run={run} />
    </ConfirmProvider>,
  );

beforeEach(() => {
  vi.mocked(api.feelingPalette).mockResolvedValue({ candidates });
  vi.mocked(api.choosePalette).mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FeelingPalette", () => {
  it("costs nothing until asked, and says what it will cost", () => {
    show();
    expect(screen.getByText("1 Gemini call")).toBeTruthy();
    // ADR 0027: no call happens on render, only on a press.
    expect(api.feelingPalette).not.toHaveBeenCalled();
    // Nothing to choose between yet.
    expect(screen.queryByText("From the feeling")).toBeNull();
  });

  it("offers all three once asked, with the cover marked as the one in use", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /read colours/i }));

    await screen.findByText("Nocturnal, smoky, and warmer than its sleeve.");
    expect(screen.getByText("From the cover")).toBeTruthy();
    expect(screen.getByText("From the feeling")).toBeTruthy();
    expect(screen.getByText("Blend")).toBeTruthy();
    // Marked in words, not by border colour alone (curator-ui-ux §3.4).
    expect(screen.getByText("in use")).toBeTruthy();
    // The default is still what's applied — proposing changed nothing.
    expect(api.choosePalette).not.toHaveBeenCalled();
  });

  it("applies a candidate without asking — it's freely reversible", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /read colours/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /use from the feeling/i }),
    );

    await waitFor(() =>
      expect(api.choosePalette).toHaveBeenCalledWith("feelalb1", "feeling"),
    );
  });

  it("asks before going back to the cover, which re-extracts and discards", async () => {
    show(
      asset({
        palette: {
          colors: [swatch("#1B2A4A")],
          handEdited: true,
          source: "feeling",
          rationale: "Nocturnal.",
        },
        paletteCandidates: candidates,
      } as Partial<AlbumAsset>),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /use from the cover/i }),
    );
    await screen.findByText("Go back to the cover's colours?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.choosePalette).not.toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: /use from the cover/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use the cover" }),
    );
    await waitFor(() =>
      expect(api.choosePalette).toHaveBeenCalledWith("feelalb1", "cover"),
    );
  });

  it("says which palette is in force, and that a sweep won't touch it", () => {
    show(
      asset({
        palette: {
          colors: [swatch("#1B2A4A")],
          handEdited: true,
          source: "blend",
          rationale: "Nocturnal.",
        },
      } as Partial<AlbumAsset>),
    );
    expect(screen.getByText(/the blend/)).toBeTruthy();
    expect(screen.getByText(/leave it alone/)).toBeTruthy();
  });

  it("reattaches to candidates already on the album after a reload", () => {
    show(asset({ paletteCandidates: candidates } as Partial<AlbumAsset>));
    // No second Gemini call needed to see what was already proposed.
    expect(screen.getByText("From the feeling")).toBeTruthy();
    expect(api.feelingPalette).not.toHaveBeenCalled();
  });

  it("renders nothing before a cover palette exists", () => {
    const { container } = show(asset({ palette: undefined }));
    expect(container.innerHTML).toBe("");
  });
});
