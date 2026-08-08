// The tags panel (ADR 0052) — the stickers, and the one check that catches real bugs.
// Three stickers since ADR 0058, the third of which is optional and behaves differently.
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
    tagPayload: vi.fn().mockResolvedValue({
      payload: "curator:album:abc12345",
      qrDataUrl: "data:image/png;base64,AA",
    }),
    pushAlbumToFlipper: vi.fn().mockResolvedValue({
      ok: true,
      total: 3,
      port: "COM4",
      bytes: 90,
      path: "x",
    }),
    verifyTags: vi.fn().mockResolvedValue({ state: "verified" }),
    markTagWritten: vi.fn().mockResolvedValue({ state: "awaiting_tag_write" }),
  },
  tagNfcUrl: (id: string, object: string) =>
    `/api/albums/${id}/tag.nfc?object=${object}`,
}));

import { api, type AlbumAsset, type RoadieState } from "../api";
import { TagsPanel } from "./TagsPanel";

const asset = (
  state: RoadieState,
  over: Partial<AlbumAsset> = {},
): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Voodoo", artist: "D'Angelo", source: "manual" },
    roadie: {
      state,
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

const show = (a: AlbumAsset = asset("awaiting_tag_write")) =>
  render(
    <MemoryRouter>
      <TagsPanel
        curatorId="abc12345"
        asset={a}
        run={async (fn) => {
          await fn();
        }}
      />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TagsPanel — the objects", () => {
  it("shows each tag's URI and its written state in words", async () => {
    show(
      asset("awaiting_verify", {
        tag: {
          payload: "curator:album:abc12345",
          sleeve: { written: true },
        },
      }),
    );
    expect(screen.getByText("curator:album:abc12345")).toBeTruthy();
    expect(screen.getByText("curator:card:abc12345")).toBeTruthy();
    expect(screen.getByText("curator:demo:abc12345")).toBeTruthy();
    // Written-ness is a word plus a tick, never the tick alone. The card and the demo tag are both
    // unwritten here, so there are two of the second.
    expect(screen.getByText("✓ written")).toBeTruthy();
    expect(screen.getAllByText("not written yet")).toHaveLength(2);
  });

  it("renders the real QR the server generates, not a placeholder", async () => {
    show();
    await waitFor(() =>
      expect(screen.getAllByRole("img", { name: /QR code/ })).toHaveLength(3),
    );
    expect(api.tagPayload).toHaveBeenCalledWith("abc12345", "sleeve");
    expect(api.tagPayload).toHaveBeenCalledWith("abc12345", "card");
    expect(api.tagPayload).toHaveBeenCalledWith("abc12345", "demo");
  });

  it("shows the payload the server holds, not a locally derived guess", async () => {
    // A sleeve that already had a payload recorded keeps it, so it need not equal the derived
    // `curator:album:<id>`. Deriving the visible text separately would let the words disagree with
    // what the QR encodes — on the one screen whose whole job is catching that.
    vi.mocked(api.tagPayload).mockResolvedValue({
      object: "sleeve",
      payload: "curator:album:legacy-payload",
      qrDataUrl: "data:image/png;base64,AA",
    });
    show();
    await waitFor(() =>
      expect(screen.getAllByText("curator:album:legacy-payload").length).toBe(
        3,
      ),
    );
  });

  it("says so when it had to fall back to the derived URI", async () => {
    vi.mocked(api.tagPayload).mockRejectedValue(new Error("nope"));
    show();
    await waitFor(() =>
      expect(
        screen.getAllByRole("img", { name: /QR unavailable/ }).length,
      ).toBe(3),
    );
    // The panel still says what the URI *should* be — and marks it as exactly that.
    expect(screen.getByText("curator:album:abc12345")).toBeTruthy();
    expect(
      screen.getAllByText(/what it should say, not what was read/).length,
    ).toBe(3);
  });
});

describe("TagsPanel — getting them written", () => {
  it("sends this record to the Flipper, and says what landed", async () => {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: /SEND THIS RECORD TO THE FLIPPER/ }),
    );
    await waitFor(() =>
      expect(screen.getByText(/on the Flipper/)).toBeTruthy(),
    );
    expect(api.pushAlbumToFlipper).toHaveBeenCalledWith("abc12345");
  });

  it("offers no bulk send — the queue's list went with the queue", () => {
    show();
    expect(screen.queryByText(/send list|whole list|all albums/i)).toBeNull();
  });

  it("links the .nfc and the how-to", () => {
    show();
    expect(
      screen.getByRole("link", { name: "DOWNLOAD .NFC" }).getAttribute("href"),
    ).toContain("tag.nfc?object=sleeve");
    expect(
      screen
        .getByRole("link", { name: /HOW DO I WRITE THESE/ })
        .getAttribute("href"),
    ).toBe("/help/tags");
  });
});

describe("TagsPanel — the check", () => {
  it("is one button for both tags", async () => {
    show();
    expect(screen.getAllByRole("button", { name: /VERIFIED/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "TAGS VERIFIED" }));
    await waitFor(() =>
      expect(api.verifyTags).toHaveBeenCalledWith("abc12345"),
    );
  });

  it("is pressable before the rest of the record is done", async () => {
    // regression: #261 — this was gated on the linear machine, so on a record with no visualizer
    // (478 of 499 in the real collection) the button was dead and nothing else on the panel could
    // record a written sticker. A sticker is a physical object; writing and checking it does not
    // wait on a visualizer (ADR 0062).
    show(asset("awaiting_review"));
    const btn = screen.getByRole("button", { name: "TAGS VERIFIED" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.verifyTags).toHaveBeenCalledWith("abc12345"),
    );
  });

  it("is pressable from awaiting_verify too, not only from the tag step", () => {
    show(asset("awaiting_verify"));
    expect(
      (
        screen.getByRole("button", {
          name: "TAGS VERIFIED",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("keeps the check visually its own step, with the reason it matters", () => {
    show();
    expect(screen.getByText("THEN CHECK THEM")).toBeTruthy();
    expect(screen.getByText(/This is where the bugs turn up/)).toBeTruthy();
  });

  it("says so once it has been done, and stops offering the press", () => {
    show(
      asset("verified", {
        verification: { physicallyVerifiedAt: "2026-08-01T00:00:00.000Z" },
      }),
    );
    const btn = screen.getByRole("button", {
      name: /TAGS VERIFIED ✓/,
    }) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // The only remaining reason to withhold the press: it has already been done, and the panel
    // says when rather than going quiet (#261).
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/^checked /)).toBeTruthy();
  });

  it("never says 'I've put it on the shelf'", () => {
    show();
    expect(screen.queryByText(/shelf\b(?!.*card)/i)).toBeNull();
    expect(screen.queryByText(/physically verified/i)).toBeNull();
  });
});

/**
 * Recording a sticker one at a time (#261). `TAGS VERIFIED` covers the sleeve and the card in one
 * press because you write them in one sitting — but it is the *check*, and a panel where the only
 * control is the check has nothing to say the evening you wrote the stickers and haven't tapped
 * them yet. Every sticker on this panel can now record its own write.
 */
describe("TagsPanel — recording a written sticker", () => {
  it("gives every unwritten sticker its own write control", () => {
    show(asset("awaiting_review"));
    expect(
      screen.getAllByRole("button", { name: /^I've written/ }),
    ).toHaveLength(3);
  });

  it.each([
    ["I've written the sleeve", "sleeve"],
    ["I've written the shelf card", "card"],
  ])("records the %s write against its own object", async (name, object) => {
    show(asset("awaiting_review"));
    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() =>
      expect(api.markTagWritten).toHaveBeenCalledWith("abc12345", object),
    );
  });

  it("drops a sticker's control once that sticker is recorded", () => {
    show(
      asset("awaiting_review", {
        tag: { payload: "curator:album:abc12345", sleeve: { written: true } },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "I've written the sleeve" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "I've written the shelf card" }),
    ).toBeTruthy();
  });

  /**
   * The visible words stay identical on all three — you are answering the same question about the
   * sticker beside it. The accessible name is where they differ, so a screen reader never reads
   * three buttons that sound alike.
   */
  it("keeps one wording on screen and distinct names for a screen reader", () => {
    show(asset("awaiting_review"));
    expect(screen.getAllByText("I'VE WRITTEN THIS ONE")).toHaveLength(3);
  });
});

/**
 * The demo tag (ADR 0058). Optional in a way the other two are not, and the only sticker whose
 * behaviour depends on a choice made on a different tab — so what it *plays* is the fact this panel
 * must never get wrong.
 */
describe("TagsPanel — the demo tag", () => {
  it("shows the demo URI beside the other two", async () => {
    show();
    await waitFor(() =>
      expect(screen.getByText("curator:demo:abc12345")).toBeTruthy(),
    );
    expect(screen.getByText("THE DEMO TAG")).toBeTruthy();
  });

  it("names the song it will play once one is chosen", () => {
    show(
      asset("awaiting_tag_write", {
        demoTrack: {
          spotifyUri: "spotify:track:t1",
          name: "Untitled (How Does It Feel)",
          chosenAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    );
    expect(screen.getByText(/Untitled \(How Does It Feel\)/)).toBeTruthy();
  });

  /**
   * With no cut chosen the tag plays the whole record — identical to the shelf card. Saying so is
   * the difference between "this tag is broken" and "I never picked a song", and it is the only
   * place the fallback is visible before you are standing at the stand.
   */
  it("says it plays the whole record when no cut has been chosen", () => {
    show();
    expect(
      screen.getByText(/no cut chosen — plays the whole record/),
    ).toBeTruthy();
  });

  it("records its own write — TAGS VERIFIED does not cover it", async () => {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: "I've written the demo tag" }),
    );
    await waitFor(() =>
      expect(api.markTagWritten).toHaveBeenCalledWith("abc12345", "demo"),
    );
  });

  it("drops its own write control once the sticker is recorded", () => {
    show(
      asset("awaiting_tag_write", {
        tag: { payload: "curator:album:abc12345", demo: { written: true } },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "I've written the demo tag" }),
    ).toBeNull();
  });

  it("offers the demo .nfc separately from the sleeve's", () => {
    show();
    expect(
      screen
        .getByRole("link", { name: "DOWNLOAD DEMO .NFC" })
        .getAttribute("href"),
    ).toContain("tag.nfc?object=demo");
  });
});
