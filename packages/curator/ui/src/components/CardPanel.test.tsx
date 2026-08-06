// The card panel (ADR 0052) — four candidates, big enough to judge, with the chosen one obvious.
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
    selectCardArt: vi.fn().mockResolvedValue({}),
    generateCardArtSet: vi.fn().mockResolvedValue({}),
    uploadCardArt: vi.fn().mockResolvedValue({}),
  },
  cardArtUrl: (id: string) => `/api/albums/${id}/card-art`,
  cardArtCandidateUrl: (id: string, i: number) =>
    `/api/albums/${id}/card-art/candidate/${i}`,
}));

import { api, type AlbumAsset } from "../api";
import { CardPanel } from "./CardPanel";

const candidate = (index: number, fileId: string) => ({
  index,
  fileId,
  ext: "png",
  generatedAt: "2026-08-01T00:00:00.000Z",
});

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Aja", artist: "Steely Dan", source: "manual" },
    cardArtCandidates: [
      candidate(0, "f0"),
      candidate(1, "f1"),
      candidate(2, "f2"),
      candidate(3, "f3"),
    ],
    cardArt: {
      fileId: "f1",
      originalFilename: "one.png",
      ext: "png",
      attachedAt: "2026-08-01T00:00:00.000Z",
    },
    roadie: {
      state: "awaiting_preview",
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
    status: { highLevel: "", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

const show = (a: AlbumAsset = asset(), canGenerate = true) =>
  render(
    <CardPanel
      curatorId="abc12345"
      asset={a}
      refresh={() => {}}
      canGenerate={canGenerate}
      run={async (fn) => {
        await fn();
      }}
    />,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/**
 * Drive the OS file chooser that `pickFile` opens.
 *
 * It builds a *detached* input and clicks it — right for the UI (nothing there needs tabbing to; the
 * visible button is the control) and unreachable from the rendered tree, so the test intercepts the
 * element at creation instead. `files` is read-only in jsdom, hence the defineProperty.
 */
const choose = (file: File, click: () => void) => {
  const real = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tag: string) => {
      const el = real(tag);
      if (tag === "input") {
        Object.defineProperty(el, "files", { value: [file] });
        (el as HTMLInputElement).click = () =>
          (el as HTMLInputElement).onchange?.(new Event("change"));
      }
      return el;
    });
  click();
  spy.mockRestore();
};

describe("CardPanel", () => {
  it("marks exactly one card in use, and offers the rest as a swap", () => {
    show();
    expect(screen.getAllByText("IN USE")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "USE THIS ONE INSTEAD" }),
    ).toHaveLength(3);
  });

  it("matches the attached card by fileId, not by index", () => {
    // A regeneration renumbers the candidates; matching on index would put the IN USE mark on
    // whichever card happened to land in that slot.
    show(
      asset({
        cardArtCandidates: [candidate(7, "f1"), candidate(8, "f2")],
      }),
    );
    const inUse = screen.getByText("IN USE").closest("figure")!;
    expect(inUse.querySelector("img")!.getAttribute("src")).toContain(
      "/candidate/7",
    );
  });

  it("says 'use', never 'keep'", () => {
    show();
    expect(screen.queryByText(/keep/i)).toBeNull();
  });

  it("downloads the one in use, and offers no print sheet", () => {
    show();
    const dl = screen.getByRole("link", { name: "DOWNLOAD" });
    expect(dl.getAttribute("href")).toContain("/api/albums/abc12345/card-art");
    expect(dl.getAttribute("download")).toBe("abc12345-card.png");
    expect(screen.queryByText(/print/i)).toBeNull();
  });

  it("keys the attached card on when it was attached, so REPLACE isn't served from cache", () => {
    // Without the token the `src` string never changes across a replace, and the browser keeps
    // showing the old image until a hard reload — issue #25's trap, in a third place.
    show(
      asset({
        cardArtCandidates: [],
        cardArt: {
          fileId: "mine",
          originalFilename: "mine.png",
          ext: "png",
          attachedAt: "2026-08-05T09:00:00.000Z",
        },
      }),
    );
    const src = document.querySelector(".card__img")!.getAttribute("src")!;
    expect(src).toContain(
      `?v=${encodeURIComponent("2026-08-05T09:00:00.000Z")}`,
    );
  });

  it("swaps to another candidate", async () => {
    show();
    fireEvent.click(
      screen.getAllByRole("button", { name: "USE THIS ONE INSTEAD" })[0]!,
    );
    await waitFor(() =>
      expect(api.selectCardArt).toHaveBeenCalledWith("abc12345", 0),
    );
  });

  it("still shows an uploaded card that was never a candidate", () => {
    show(
      asset({
        cardArtCandidates: [],
        cardArt: {
          fileId: "mine",
          originalFilename: "mine.jpg",
          ext: "jpg",
          attachedAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );
    expect(screen.getByText("IN USE")).toBeTruthy();
    expect(screen.getByRole("link", { name: "DOWNLOAD" })).toBeTruthy();
  });

  it("drops a candidate whose image won't load rather than showing a broken glyph", () => {
    show();
    expect(document.querySelectorAll("img")).toHaveLength(4);
    fireEvent.error(document.querySelectorAll("img")[3]!);
    expect(document.querySelectorAll("img")).toHaveLength(3);
  });

  it("offers a way in when there is nothing yet", () => {
    show(asset({ cardArtCandidates: [], cardArt: undefined }));
    expect(screen.getByText(/No card yet/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /ASK ROADIE TO DRAW SOME/ }),
    ).toBeTruthy();
  });

  it("marks the control that spends money, and disables it when generation is off", () => {
    show(asset(), false);
    const ask = screen.getByRole("button", { name: /ASK FOR MORE/ });
    expect(ask.textContent).toContain("◈");
    expect((ask as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes an upload whatever else is on screen", async () => {
    show();
    const file = new File(["png"], "mine.png", { type: "image/png" });
    choose(file, () =>
      fireEvent.click(screen.getByRole("button", { name: "UPLOAD MY OWN" })),
    );
    await waitFor(() => expect(api.uploadCardArt).toHaveBeenCalled());
    const form = vi.mocked(api.uploadCardArt).mock.calls[0]![1];
    expect(vi.mocked(api.uploadCardArt).mock.calls[0]![0]).toBe("abc12345");
    expect((form as FormData).get("file")).toBe(file);
  });

  it("takes an upload from the empty state too", async () => {
    show(asset({ cardArtCandidates: [], cardArt: undefined }));
    const file = new File(["jpg"], "mine.jpg", { type: "image/jpeg" });
    choose(file, () =>
      fireEvent.click(screen.getByRole("button", { name: "UPLOAD MY OWN" })),
    );
    await waitFor(() => expect(api.uploadCardArt).toHaveBeenCalled());
  });
});
