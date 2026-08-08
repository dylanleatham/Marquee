// The demo-cut panel (ADR 0058) — choosing the one song a demo tag plays.
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
    tracks: vi.fn(),
    setDemoTrack: vi.fn().mockResolvedValue({ demoTrack: null }),
    setSpotifyUri: vi
      .fn()
      .mockResolvedValue({ spotifyUri: null, demoTrack: null }),
  },
}));

import { api, type AlbumAsset, type DemoTrack } from "../api";
import { DemoPanel } from "./DemoPanel";

const TRACKS = [
  {
    spotifyUri: "spotify:track:t1",
    name: "Playa Playa",
    trackNumber: 1,
    discNumber: 1,
    durationMs: 428_000,
  },
  {
    spotifyUri: "spotify:track:t2",
    name: "Devil's Pie",
    trackNumber: 2,
    discNumber: 1,
    durationMs: 322_000,
  },
];

const asset = (demoTrack?: DemoTrack | null): AlbumAsset =>
  ({
    curatorId: "abc12345",
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: { name: "Voodoo", artist: "D'Angelo", source: "spotify" },
    demoTrack,
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
  }) as AlbumAsset;

const show = (a: AlbumAsset = asset()) =>
  render(
    <MemoryRouter>
      <DemoPanel
        curatorId="abc12345"
        asset={a}
        run={async (fn) => {
          await fn();
        }}
      />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.tracks).mockResolvedValue({ tracks: TRACKS });
});
afterEach(cleanup);

describe("DemoPanel — the tracklist", () => {
  it("lists the album's songs with their numbers and lengths", async () => {
    show();
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    expect(screen.getByText("Devil's Pie")).toBeTruthy();
    expect(screen.getByText("7:08")).toBeTruthy(); // 428s
    expect(screen.getByText("5:22")).toBeTruthy(); // 322s
  });

  /**
   * A record with no tracklist — a manual pressing, no Spotify credentials, Spotify down — is an
   * ordinary state of this screen, not a failure of it. The server sends a sentence; the panel shows
   * that sentence rather than an error, or worse, an empty list with no explanation.
   */
  it("shows the server's reason in place of an empty list", async () => {
    vi.mocked(api.tracks).mockResolvedValue({
      tracks: [],
      reason: "This record isn't on Spotify, so there's no tracklist",
    });
    show();
    await waitFor(() =>
      expect(screen.getByText(/isn't on Spotify/)).toBeTruthy(),
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a transport failure the same way — one place says why there is no list", async () => {
    vi.mocked(api.tracks).mockRejectedValue(new Error("network down"));
    show();
    await waitFor(() => expect(screen.getByText(/network down/)).toBeTruthy());
  });
});

describe("DemoPanel — choosing", () => {
  it("records the chosen track, with what the picker knows about it", async () => {
    show();
    await waitFor(() => expect(screen.getByText("Devil's Pie")).toBeTruthy());
    fireEvent.click(
      screen.getAllByRole("button", { name: "USE THIS ONE" })[1]!,
    );

    await waitFor(() =>
      expect(api.setDemoTrack).toHaveBeenCalledWith("abc12345", {
        spotifyUri: "spotify:track:t2",
        name: "Devil's Pie",
        trackNumber: 2,
        durationMs: 322_000,
      }),
    );
  });

  it("marks the chosen row and offers no second choose on it", async () => {
    show(
      asset({
        spotifyUri: "spotify:track:t1",
        name: "Playa Playa",
        trackNumber: 1,
        chosenAt: "2026-08-08T00:00:00.000Z",
      }),
    );
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());

    expect(screen.getByText("IN USE")).toBeTruthy();
    // The other track still offers its button; the chosen one does not.
    expect(
      screen.getAllByRole("button", { name: "USE THIS ONE" }),
    ).toHaveLength(1);
  });

  it("states the choice in words above the list, not only as a row marker", () => {
    show(
      asset({
        spotifyUri: "spotify:track:t2",
        name: "Devil's Pie",
        trackNumber: 2,
        durationMs: 322_000,
        chosenAt: "2026-08-08T00:00:00.000Z",
      }),
    );
    expect(screen.getByText("Devil's Pie")).toBeTruthy();
    expect(screen.getByText(/Track 2 · 5:22/)).toBeTruthy();
  });

  /**
   * Clearing is not a deletion: with no cut chosen the demo tag plays the whole record, exactly as
   * the shelf card does. Both the control's words and the empty state say that, because "cleared"
   * would leave you expecting silence in the room.
   */
  it("clears the choice, and calls it playing the whole record", async () => {
    show(
      asset({
        spotifyUri: "spotify:track:t1",
        name: "Playa Playa",
        chosenAt: "2026-08-08T00:00:00.000Z",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /PLAY THE WHOLE RECORD INSTEAD/ }),
    );
    await waitFor(() =>
      expect(api.setDemoTrack).toHaveBeenCalledWith("abc12345", null),
    );
  });

  it("says what happens with no cut chosen, rather than leaving it blank", () => {
    show();
    expect(screen.getByText(/plays the whole record/)).toBeTruthy();
  });

  /**
   * No preview button here, deliberately: you judge a demo cut by hearing it in the room, and the
   * room already plays audio. A quieter second way to play it would make the honest answer the
   * harder one.
   */
  it("offers no preview — that judgement belongs in the room", async () => {
    show();
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /play|preview|listen/i })).toBe(
      null,
    );
  });
});

/**
 * Which Spotify album this record is (ADR 0059, made always-visible by ADR 0060).
 *
 * The first version only appeared when there was no tracklist, so it could fix a *missing* match and
 * not a *wrong* one. Once ADR 0060 loosened the rule, a wrong-edition match became the failure to
 * expect — and that one shows up as a tracklist full of the wrong songs, with the fix needing to be
 * right next to them.
 */
describe("DemoPanel — which album this is on Spotify", () => {
  const linked = (over: Partial<AlbumAsset["metadata"]> = {}) => {
    const a = asset();
    a.metadata = { ...a.metadata, spotifyUri: "spotify:album:abc", ...over };
    return a;
  };

  it("shows an automatic match by name, so a wrong one is visible", async () => {
    show(
      linked({
        spotifyMatch: {
          confidence: "exact",
          name: "Voodoo",
          artist: "D'Angelo",
          year: 2000,
          matchedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());

    expect(screen.getByText(/matched automatically to/)).toBeTruthy();
    expect(screen.getByText(/D'Angelo — Voodoo/)).toBeTruthy();
    expect(screen.getByText(/\(2000\)/)).toBeTruthy();
  });

  /** The case the empty-state-only version could never reach: songs are listed, and they're wrong. */
  it("is offered even when there IS a tracklist", async () => {
    show(linked());
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    expect(
      screen.getByRole("button", { name: /USE A DIFFERENT ALBUM/i }),
    ).toBeTruthy();
  });

  /**
   * No `spotifyMatch` means nobody guessed — either a Spotify add or a human pasting it. Both are
   * facts, and neither should be described as a match the user might want to check.
   */
  it("distinguishes a hand-linked album from a guessed one", async () => {
    // The state line is built from several nodes, so match on the element's whole text.
    const stateText = () =>
      document.querySelector(".demo__uri-state")?.textContent ?? "";

    const { unmount } = show(linked({ source: "discogs" }));
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    expect(stateText()).toMatch(/linked by hand/);
    expect(screen.queryByText(/matched automatically/)).toBeNull();
    unmount();

    show(linked({ source: "spotify" }));
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    expect(stateText()).toMatch(/added from Spotify/);
  });

  it("says so when nothing is linked, and offers to paste", async () => {
    vi.mocked(api.tracks).mockResolvedValue({ tracks: [], reason: "no match" });
    show();
    await waitFor(() =>
      expect(screen.getByText(/not linked to a Spotify album/)).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: /PASTE THE ALBUM/i }),
    ).toBeTruthy();
    // Nothing to unlink when nothing is linked.
    expect(screen.queryByRole("button", { name: /UNLINK/i })).toBeNull();
  });

  it("saves a pasted share link", async () => {
    show(linked());
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("button", { name: /USE A DIFFERENT ALBUM/i }),
    );
    fireEvent.change(screen.getByLabelText(/Paste this record on Spotify/i), {
      target: { value: "https://open.spotify.com/album/xyz789?si=x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /USE THIS ALBUM/i }));

    await waitFor(() =>
      expect(api.setSpotifyUri).toHaveBeenCalledWith(
        "abc12345",
        "https://open.spotify.com/album/xyz789?si=x",
      ),
    );
  });

  it("unlinks on request", async () => {
    show(linked());
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /UNLINK/i }));
    await waitFor(() =>
      expect(api.setSpotifyUri).toHaveBeenCalledWith("abc12345", null),
    );
  });

  it("won't submit an empty box", async () => {
    show(linked());
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("button", { name: /USE A DIFFERENT ALBUM/i }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: /USE THIS ALBUM/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  /** The sweep is the answer for hundreds of records; a button here invites using it to fix one. */
  it("points at the library-wide sweep as a link, not a button", async () => {
    show(linked());
    await waitFor(() => expect(screen.getByText("Playa Playa")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("button", { name: /USE A DIFFERENT ALBUM/i }),
    );
    expect(
      screen
        .getByRole("link", { name: /Settings → Library/i })
        .getAttribute("href"),
    ).toBe("/settings");
  });
});
