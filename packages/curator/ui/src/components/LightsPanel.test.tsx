// The Lights panel (ADR 0052). The behaviour worth pinning is autosave — it replaced an explicit
// Save button, so every way it could silently lose an edit is a regression that looks like nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  api: {
    editPalette: vi.fn().mockResolvedValue({}),
    choosePalette: vi.fn().mockResolvedValue({}),
    feelingPalette: vi.fn().mockResolvedValue({}),
    uploadArtworkOverride: vi.fn().mockResolvedValue({}),
    removeArtworkOverride: vi.fn().mockResolvedValue({}),
  },
  // The real shape, because the panel branches on `status` — sniffing the message text would pass
  // this test and then break the day the server rewords its 409.
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

import { api, ApiError, type AlbumAsset } from "../api";
import { ConfirmProvider } from "./Confirm";
import { LightsPanel } from "./LightsPanel";

const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Purple Rain", artist: "Prince", source: "manual" },
    palette: {
      colors: [
        { hex: "#4B0082", role: "primary" },
        { hex: "#8A2BE2", role: "secondary" },
        { hex: "#FFD700", role: "accent" },
      ],
      source: "cover",
    },
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
    status: { highLevel: "", next: null, issues: [] },
    ...over,
  }) as AlbumAsset;

/**
 * Routed: the sign-off line links to the room, which is the only place lights are signed off.
 * Wrapped in the real `ConfirmProvider`, because the hand-edit dialog the cover upload asks
 * (curator-spec §12) is the behaviour worth pinning, and `useConfirm` outside a provider silently
 * answers `true` — i.e. a stub here would test the one path that never protects anything.
 */
const panel = (a: AlbumAsset) => (
  <MemoryRouter>
    <ConfirmProvider>
      <LightsPanel
        curatorId="abc12345"
        asset={a}
        refresh={() => {}}
        run={async (fn) => {
          await fn();
        }}
      />
    </ConfirmProvider>
  </MemoryRouter>
);

const show = (a: AlbumAsset = asset()) => render(panel(a));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const hexField = (n: number) => screen.getByLabelText(`Light ${n} hex`);
const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
};

describe("LightsPanel — autosave", () => {
  it("says the rule, not just the state — the missing Save button has to be explained", () => {
    show();
    expect(screen.getByText(/edits save as you make them/)).toBeTruthy();
  });

  it("saves an edit without being asked", async () => {
    show();
    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    await settle();
    expect(api.editPalette).toHaveBeenCalledWith("abc12345", [
      { hex: "#112233" },
      { hex: "#8A2BE2" },
      { hex: "#FFD700" },
    ]);
    await waitFor(() => expect(screen.getByText(/^saved /)).toBeTruthy());
  });

  it("coalesces a burst of edits into one write", async () => {
    // Dragging the colour picker fires a change per frame. One save, not forty.
    show();
    for (const v of ["#111111", "#222222", "#333333"])
      fireEvent.change(hexField(1), { target: { value: v } });
    await settle();
    expect(api.editPalette).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.editPalette).mock.calls[0]![1][0]).toEqual({
      hex: "#333333",
    });
  });

  it("holds back while a hex is half-typed instead of writing rubbish", async () => {
    show();
    fireEvent.change(hexField(1), { target: { value: "#11" } });
    await settle();
    expect(api.editPalette).not.toHaveBeenCalled();
    // The field still shows what was typed — the save waits, the input doesn't.
    expect((hexField(1) as HTMLInputElement).value).toBe("#11");

    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    await settle();
    expect(api.editPalette).toHaveBeenCalledTimes(1);
  });

  it("flushes an in-flight edit when the panel goes away", async () => {
    // Without this, autosave is *worse* than the Save button: an edit made inside the debounce
    // window and then navigated away from would vanish with no trace at all.
    const { unmount } = show();
    fireEvent.change(hexField(1), { target: { value: "#445566" } });
    expect(api.editPalette).not.toHaveBeenCalled();
    unmount();
    expect(api.editPalette).toHaveBeenCalledWith("abc12345", [
      { hex: "#445566" },
      { hex: "#8A2BE2" },
      { hex: "#FFD700" },
    ]);
  });

  it("explains a 409 in a sentence rather than showing the status code", async () => {
    vi.mocked(api.editPalette).mockRejectedValueOnce(
      new ApiError("album is processing", 409),
    );
    show();
    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    await settle();
    await waitFor(() =>
      expect(screen.getByText(/Roadie is working on this record/)).toBeTruthy(),
    );
    expect(screen.queryByText(/409/)).toBeNull();
  });

  it("still says something useful for a failure that isn't a conflict", async () => {
    vi.mocked(api.editPalette).mockRejectedValueOnce(
      new ApiError("the disk is full", 500),
    );
    show();
    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    await settle();
    await waitFor(() =>
      expect(
        screen.getByText(/That didn't save — the disk is full/),
      ).toBeTruthy(),
    );
  });

  it("reorders without a save button, and the roles follow the order", async () => {
    show();
    fireEvent.click(screen.getByLabelText("Move light 2 earlier"));
    await settle();
    expect(api.editPalette).toHaveBeenCalledWith("abc12345", [
      { hex: "#8A2BE2" },
      { hex: "#4B0082" },
      { hex: "#FFD700" },
    ]);
  });
});

describe("LightsPanel — reconciling with the poll", () => {
  // The page re-polls the asset every 3s, so a palette that changed elsewhere — a swap, a library
  // sweep, Roadie — arrives while you may be mid-edit. Getting this wrong in either direction is
  // invisible: adopt too eagerly and an unsaved edit vanishes under the cursor; never adopt and the
  // panel quietly shows colours the record no longer has.
  const swapped = asset({
    palette: {
      colors: [{ hex: "#2B0B3F", role: "primary" }],
      source: "feeling",
    },
  });

  it("adopts a palette that changed elsewhere while nothing is being edited", async () => {
    const { rerender } = show();
    expect((hexField(1) as HTMLInputElement).value).toBe("#4B0082");
    rerender(panel(swapped));
    await waitFor(() =>
      expect((hexField(1) as HTMLInputElement).value).toBe("#2B0B3F"),
    );
  });

  it("never overwrites an edit that has not been written yet", async () => {
    const { rerender } = show();
    fireEvent.change(hexField(1), { target: { value: "#ABCDEF" } });
    // The poll lands mid-debounce, before the edit has reached the server.
    rerender(panel(swapped));
    expect((hexField(1) as HTMLInputElement).value).toBe("#ABCDEF");
    // …and the edit still saves, rather than being stranded by the reconciliation.
    await settle();
    expect(api.editPalette).toHaveBeenCalledWith("abc12345", [
      { hex: "#ABCDEF" },
      { hex: "#8A2BE2" },
      { hex: "#FFD700" },
    ]);
  });

  it("does not treat the echo of its own save as someone else's change", async () => {
    // The save is followed by a refresh, so the very next poll returns what was just written. That
    // must be a no-op, not a re-adopt that resets the panel's state.
    const { rerender } = show();
    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    await settle();
    const echoed = asset({
      palette: {
        colors: [
          { hex: "#112233", role: "primary" },
          { hex: "#8A2BE2", role: "secondary" },
          { hex: "#FFD700", role: "accent" },
        ],
        source: "hand",
      },
    });
    rerender(panel(echoed));
    expect((hexField(1) as HTMLInputElement).value).toBe("#112233");
    expect(screen.getByText(/^saved /)).toBeTruthy();
    expect(api.editPalette).toHaveBeenCalledTimes(1);
  });
});

describe("LightsPanel — the two source palettes", () => {
  it("marks the one in use and offers the other, never destroying either", () => {
    show(
      asset({
        paletteCandidates: {
          generatedAt: "2026-08-01T00:00:00.000Z",
          rationale: "Late-night and smoky.",
          cover: [{ hex: "#4B0082", role: "primary" }],
          feeling: [{ hex: "#2B0B3F", role: "primary" }],
          blend: [{ hex: "#4B0082", role: "primary" }],
        },
      }),
    );
    expect(screen.getByText("· IN USE")).toBeTruthy();
    expect(screen.getByRole("button", { name: "IN USE" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "USE THIS INSTEAD →" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/nothing you do to this list destroys either/),
    ).toBeTruthy();
  });

  it("marks the control that spends money as one that does", () => {
    // No candidates yet, so the feeling palette has to be asked for — and asking costs a Gemini
    // call, which curator-ui-ux §7 says must not look like a control that costs nothing.
    show();
    const ask = screen.getByRole("button", { name: /ASK FOR THESE/ });
    expect(ask.textContent).toContain("◈");
    fireEvent.click(ask);
    expect(api.feelingPalette).toHaveBeenCalledWith("abc12345");
  });

  it("goes back to Roadie's original by re-choosing the cover", async () => {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: /BACK TO ROADIE'S ORIGINAL/ }),
    );
    await waitFor(() =>
      expect(api.choosePalette).toHaveBeenCalledWith("abc12345", "cover"),
    );
  });

  it("shows Roadie's note when there is one, and nothing when there isn't", () => {
    // A plain cover extraction has no note. Inventing a sentence would be worse than the gap.
    show();
    expect(screen.queryByText(/Late-night/)).toBeNull();
    cleanup();
    show(
      asset({
        palette: {
          colors: [{ hex: "#4B0082", role: "primary" }],
          source: "feeling",
          rationale: "Late-night and smoky.",
        },
      }),
    );
    expect(screen.getByText("Late-night and smoky.")).toBeTruthy();
  });
});

/**
 * regression: #263 — "there doesn't appear to be UI to confirm that lights have been approved. The
 * circle is always open in the album menu and I can't mark it as verified." The tab's `●`/`○` said
 * the state and nothing on the tab said how to change it, or that a sign-off had ever happened.
 */
describe("LightsPanel — the sign-off", () => {
  it("says when the lights were signed off", () => {
    show(
      asset({
        verification: { previewApprovedAt: new Date().toISOString() },
      } as Partial<AlbumAsset>),
    );
    expect(screen.getByText(/^signed off /)).toBeTruthy();
  });

  it("says they aren't, and points at the one place that can", () => {
    show();
    expect(screen.getByText(/not signed off yet/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /see it in the room/ });
    expect(link.getAttribute("href")).toBe("/room/abc12345");
  });

  it("never offers a second approve button — sign-off means having watched it", () => {
    show();
    for (const gone of [/looks right/i, /sign.?off/i, /approve/i])
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
  });
});

/**
 * The artwork override, back on this panel by [ADR 0084](../../../../../docs/adrs/0084-your-own-cover-is-a-palette-control.md).
 *
 * The cover is the palette's *input*, so the thing worth pinning is not that a file goes up — it is
 * every way a cover swap can quietly take colours with it: the hand-edit dialog curator-spec §12 has
 * specified since the override was first built, the debounced autosave that must not land after the
 * server re-extracts, and the two sentences that stop claiming "the sleeve" once your own cover is
 * the one in force.
 */
describe("LightsPanel — your own cover", () => {
  const overridden = (over: Partial<AlbumAsset> = {}) =>
    asset({
      artwork: {
        resolvedPath: "media/artwork/abc12345-override.png",
        contentHash: "deadbeef",
        overrideActive: true,
      },
      ...over,
    } as Partial<AlbumAsset>);

  const handEdited = (over: Partial<AlbumAsset> = {}) =>
    asset({
      palette: {
        colors: [{ hex: "#4B0082", role: "primary" }],
        source: "hand",
        handEdited: true,
      },
      ...over,
    });

  /**
   * Drive the OS file chooser `pickFile` opens. It builds a *detached* input and clicks it — right
   * for the UI, and unreachable from the rendered tree, so the test intercepts the element at
   * creation. Same helper as CardPanel.test.tsx, for the same reason. `files` is read-only in jsdom,
   * hence the defineProperty.
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

  const cover = () => new File(["png"], "my-scan.png", { type: "image/png" });
  const upload = (a: AlbumAsset = asset()) => {
    show(a);
    choose(cover(), () =>
      fireEvent.click(
        screen.getByRole("button", { name: "UPLOAD A DIFFERENT COVER" }),
      ),
    );
  };
  /** What the caller answered the §12 dialog — `undefined` when it was never asked. */
  const sentRegenerate = () =>
    vi.mocked(api.uploadArtworkOverride).mock.calls[0]?.[2];

  it("sits to the right of BACK TO ROADIE'S ORIGINAL", () => {
    // The position is the point: the cover belongs beside the controls that re-derive from it, not
    // on a tab of its own — you find out the scan is bad while looking at the colours it produced.
    show();
    const labels = Array.from(
      document.querySelector(".lights__actions")!.querySelectorAll("button"),
    ).map((b) => b.textContent);
    expect(labels).toEqual([
      "+ ADD A LIGHT",
      "BACK TO ROADIE'S ORIGINAL",
      "UPLOAD A DIFFERENT COVER",
    ]);
  });

  it("sends the picked file and pulls new colours from it", async () => {
    upload();
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    const [id, file] = vi.mocked(api.uploadArtworkOverride).mock.calls[0]!;
    expect(id).toBe("abc12345");
    expect((file as File).name).toBe("my-scan.png");
    expect(sentRegenerate()).toBe(true);
  });

  it("asks nothing when there is no hand-edit to protect", async () => {
    // The dialog is protection, not ceremony: re-deriving is the whole reason you uploaded a cover.
    upload();
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  // curator-spec §12: "never overwrite a hand-edit without user action."
  it("asks before a new cover re-derives a hand-edited palette", async () => {
    upload(handEdited());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("edited these lights by hand");
    // Nothing has gone up yet — the question is asked *before* the upload, not after it fails.
    expect(api.uploadArtworkOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "PULL NEW COLOURS" }));
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    expect(sentRegenerate()).toBe(true);
  });

  it("keeps the hand-edit when told to — and puts the cover on anyway", async () => {
    upload(handEdited());
    fireEvent.click(
      await screen.findByRole("button", { name: "KEEP MY COLOURS" }),
    );
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    expect(sentRegenerate()).toBe(false);
  });

  it("treats a dismissal as keeping the colours, the side that loses nothing", async () => {
    // Escape and the scrim both resolve `false`. Landing on "regenerate" would make the safe answer
    // the one you have to remember to give.
    upload(handEdited());
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    expect(sentRegenerate()).toBe(false);
  });

  it("drops a debounced edit rather than writing it over the new extraction", async () => {
    // The autosave timer is still armed when the upload starts. Letting it fire would PUT the old
    // colours back on top of the palette the server has just derived from the new cover — an edit
    // that looks saved and a cover swap that looks ignored, from one race.
    show();
    fireEvent.change(hexField(1), { target: { value: "#112233" } });
    choose(cover(), () =>
      fireEvent.click(
        screen.getByRole("button", { name: "UPLOAD A DIFFERENT COVER" }),
      ),
    );
    await waitFor(() => expect(api.uploadArtworkOverride).toHaveBeenCalled());
    await settle();
    expect(api.editPalette).not.toHaveBeenCalled();
  });

  it("offers the way back only once a cover of your own is in force", () => {
    show();
    expect(
      screen.queryByRole("button", { name: /USE THE COVER ROADIE FOUND/ }),
    ).toBeNull();
    cleanup();
    show(overridden());
    expect(
      screen.getByRole("button", { name: /USE THE COVER ROADIE FOUND/ }),
    ).toBeTruthy();
  });

  it("puts Roadie's cover back, re-deriving from it", async () => {
    show(overridden());
    fireEvent.click(
      screen.getByRole("button", { name: /USE THE COVER ROADIE FOUND/ }),
    );
    await waitFor(() =>
      expect(api.removeArtworkOverride).toHaveBeenCalledWith("abc12345", true),
    );
  });

  it("asks about a hand-edit on the way back too — the DELETE re-derives by default", async () => {
    // This route's server-side default is the opposite of the upload's: it regenerates whether or
    // not the palette was hand-edited, so §12 is the caller's to honour here.
    show(
      overridden({
        palette: {
          colors: [{ hex: "#4B0082", role: "primary" }],
          source: "hand",
          handEdited: true,
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /USE THE COVER ROADIE FOUND/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "KEEP MY COLOURS" }),
    );
    await waitFor(() =>
      expect(api.removeArtworkOverride).toHaveBeenCalledWith("abc12345", false),
    );
  });

  it("stops calling it the sleeve once your own cover is the one in force", () => {
    // Both sentences are load-bearing. The card would otherwise name a cover the record is not
    // using, and BACK TO ROADIE'S ORIGINAL — which now re-extracts from *your* file — would be the
    // only thing on screen still promising the one Roadie found.
    show();
    expect(screen.getByText("FROM THE SLEEVE")).toBeTruthy();
    cleanup();
    show(overridden());
    expect(screen.getByText("FROM YOUR COVER")).toBeTruthy();
    expect(screen.queryByText("FROM THE SLEEVE")).toBeNull();
    expect(screen.getByText(/Your own cover is the one in force/)).toBeTruthy();
  });
});

describe("LightsPanel — what the old bench had and this doesn't", () => {
  it("has no Save, no Discard and no role dropdown", () => {
    show();
    for (const gone of [/^save/i, /^discard$/i, /reset to auto/i])
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    // Order is the meaning now; a per-row role select would let the two disagree.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says where each light lands rather than what the field is called", () => {
    show();
    expect(screen.getByText("the wall wash")).toBeTruthy();
    expect(screen.getByText("the glow behind the stand")).toBeTruthy();
    expect(screen.queryByText(/primary|secondary/i)).toBeNull();
  });
});
