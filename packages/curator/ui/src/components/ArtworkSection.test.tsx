// Artwork override UI (issue #100). The property that matters: a hand-edited palette is never
// discarded without the user saying so (curator-spec §12) — and the ask happens *before* the upload,
// so a "keep" answer doesn't cost them picking the file again.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { AlbumAsset } from "../api";

vi.mock("../api", () => ({
  api: {
    uploadArtworkOverride: vi.fn(),
    removeArtworkOverride: vi.fn(),
  },
  artworkUrl: (id: string) => `/api/albums/${id}/artwork`,
}));

import { api } from "../api";
import { ArtworkSection } from "./ArtworkSection";
import { ConfirmProvider } from "./Confirm";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abcd1234",
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
    artwork: { resolvedPath: "media/artwork/abcd1234.jpg", contentHash: "h1" },
    palette: { colors: [{ hex: "#4B0082", role: "primary" }] },
    roadie: { state: "awaiting_review", flags: {} },
    ...over,
  }) as AlbumAsset;

const renderSection = (over: Partial<AlbumAsset> = {}) =>
  render(
    <ConfirmProvider>
      <ArtworkSection
        curatorId="abcd1234"
        asset={asset(over)}
        run={async (fn) => {
          await fn();
        }}
      />
    </ConfirmProvider>,
  );

const pick = (name = "scan.png") => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["x"], name, { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
};

describe("ArtworkSection", () => {
  it("offers to upload when no override is active", () => {
    renderSection();
    expect(screen.getByText("Upload my own cover")).toBeTruthy();
    expect(screen.queryByText("Revert to fetched cover")).toBeNull();
  });

  it("uploads and regenerates when the palette is not hand-edited", async () => {
    vi.mocked(api.uploadArtworkOverride).mockResolvedValue({
      artwork: undefined,
      paletteRegenerated: true,
    } as never);
    renderSection();

    pick();

    await waitFor(() =>
      expect(api.uploadArtworkOverride).toHaveBeenCalledWith(
        "abcd1234",
        expect.any(File),
        true,
      ),
    );
  });

  // curator-spec §12 — the dialog exists so a hand-edit is never silently lost.
  it("asks before discarding a hand-edited palette, and honours Keep", async () => {
    vi.mocked(api.uploadArtworkOverride).mockResolvedValue({
      artwork: undefined,
      paletteRegenerated: false,
    } as never);
    renderSection({
      palette: {
        colors: [{ hex: "#4B0082", role: "primary" }],
        handEdited: true,
      },
    });

    pick();

    expect(
      await screen.findByText("You have a hand-edited palette."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Keep my palette"));

    await waitFor(() =>
      expect(api.uploadArtworkOverride).toHaveBeenCalledWith(
        "abcd1234",
        expect.any(File),
        false,
      ),
    );
  });

  it("regenerates over a hand-edit when the user chooses to", async () => {
    vi.mocked(api.uploadArtworkOverride).mockResolvedValue({
      artwork: undefined,
      paletteRegenerated: true,
    } as never);
    renderSection({
      palette: {
        colors: [{ hex: "#4B0082", role: "primary" }],
        handEdited: true,
      },
    });

    pick();
    fireEvent.click(await screen.findByText("Regenerate from new art"));

    await waitFor(() =>
      expect(api.uploadArtworkOverride).toHaveBeenCalledWith(
        "abcd1234",
        expect.any(File),
        true,
      ),
    );
  });

  it("shows the override state and a revert control once one is active", () => {
    renderSection({
      artwork: {
        resolvedPath: "media/artwork-overrides/abcd1234.png",
        contentHash: "h2",
        overrideActive: true,
      },
    });
    expect(screen.getByText("override active")).toBeTruthy();
    expect(screen.getByText("Replace my cover")).toBeTruthy();
    expect(screen.getByText("Revert to fetched cover")).toBeTruthy();
  });

  it("confirms before reverting, and does nothing if declined", async () => {
    renderSection({
      artwork: {
        resolvedPath: "media/artwork-overrides/abcd1234.png",
        contentHash: "h2",
        overrideActive: true,
      },
    });

    fireEvent.click(screen.getByText("Revert to fetched cover"));
    fireEvent.click(await screen.findByText("Cancel"));

    await waitFor(() =>
      expect(api.removeArtworkOverride).not.toHaveBeenCalled(),
    );
  });

  it("reverts when confirmed", async () => {
    vi.mocked(api.removeArtworkOverride).mockResolvedValue({
      artwork: undefined,
      paletteRegenerated: true,
    } as never);
    renderSection({
      artwork: {
        resolvedPath: "media/artwork-overrides/abcd1234.png",
        contentHash: "h2",
        overrideActive: true,
      },
    });

    fireEvent.click(screen.getByText("Revert to fetched cover"));
    fireEvent.click(await screen.findByText("Remove override"));

    await waitFor(() =>
      expect(api.removeArtworkOverride).toHaveBeenCalledWith("abcd1234"),
    );
  });

  // The cover URL is keyed on contentHash so a new upload actually re-renders rather than showing
  // a cached image (the issue #25 pattern).
  it("cache-busts the cover on the active content hash", () => {
    renderSection();
    const img = document.querySelector<HTMLImageElement>(
      ".artwork-section__img",
    )!;
    expect(img.src).toContain("v=h1");
  });
});
