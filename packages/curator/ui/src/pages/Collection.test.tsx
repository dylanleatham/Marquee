// The collection (ADR 0052) — the screen that replaced the nine-state queue.
//
// What is asserted here is the *vocabulary and the shape*: a record shows one need and never a
// count, empty groups aren't drawn, and no machine state name or album id reaches the screen. Those
// are the rules the overhaul was actually about, and they're the ones a later change would break
// without breaking anything else.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The grid is presentational except for one act: re-enqueueing a stuck record (roadie-spec §8).
// `artworkUrl` is real because the tiles build their `src` from it.
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  api: { retry: vi.fn().mockResolvedValue({ retried: "ok" }) },
}));

import { api, type AlbumSummary } from "../api";
import { resetRoadieLog } from "../roadieLog";
import { Collection } from "./Collection";

afterEach(() => {
  cleanup();
  resetRoadieLog();
  vi.clearAllMocks();
});

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
    createdAt: "2026-08-01T00:00:00.000Z",
    state: "awaiting_review",
    artwork: null,
    paletteColors: 3,
    hasVideo: false,
    year: 1977,
    genres: ["rock"],
    paletteHexes: ["#4B0082", "#8A2BE2"],
    hasCardArt: false,
    tagsWritten: false,
    previewApprovedAt: null,
    physicallyVerifiedAt: null,
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const done = {
  state: "verified" as const,
  hasVideo: true,
  hasCardArt: true,
  tagsWritten: true,
  previewApprovedAt: "2026-08-01T10:00:00.000Z",
  physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
};

const LIBRARY: AlbumSummary[] = [
  album({
    curatorId: "2k7bxq9m",
    title: "Purple Rain",
    artist: "Prince",
    year: 1984,
  }),
  album({
    curatorId: "9xk2mp4q",
    title: "Aja",
    artist: "Steely Dan",
    ...done,
    hasVideo: false,
  }),
  album({
    curatorId: "6m3ntb8v",
    title: "Kind of Blue",
    artist: "Miles Davis",
    year: 1959,
    state: "downloading_art",
  }),
  album({
    curatorId: "5j9wqz1r",
    title: "Blue",
    artist: "Joni Mitchell",
    ...done,
  }),
  album({
    curatorId: "0z4rjc6y",
    title: "Rachel's Greatest Hits",
    artist: "Unknown",
    state: "errored",
    lastError: { message: "no match", reason: "album_not_on_spotify" },
  }),
];

/** Roadie idle with an empty queue — these cases are about the grid, not the strip. */
const IDLE = { current: null, queueDepth: 0, paused: false, activity: [] };

const show = (
  albums: AlbumSummary[] | null = LIBRARY,
  error: string | null = null,
) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Collection albums={albums} error={error} status={IDLE} />
    </MemoryRouter>,
  );

/** The tile for a record, found by its title. */
const tile = (title: string) =>
  screen.getByText(title).closest("a") as HTMLAnchorElement;

describe("Collection — the grid", () => {
  it("shows every record, plus the way to add one", () => {
    show();
    for (const t of ["Purple Rain", "Aja", "Kind of Blue", "Blue"])
      expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByText("Add a record")).toBeTruthy();
  });

  it("labels a record with its first outstanding need only — never a count", () => {
    show();
    // Purple Rain is missing all three; the tile says one thing.
    expect(
      within(tile("Purple Rain")).getByText("NEEDS VISUALIZER"),
    ).toBeTruthy();
    expect(within(tile("Purple Rain")).queryByText(/\+\d|\d of 3/)).toBeNull();
    expect(within(tile("Aja")).getByText("NEEDS VISUALIZER")).toBeTruthy();
    expect(within(tile("Blue")).getByText("READY")).toBeTruthy();
  });

  it("marks a not-complete sleeve with the fold, and only that state", () => {
    // The second of the three not-complete signals (curator-ui-ux §3.4), and the one that replaced
    // the 0.62 wash (ADR 0054). The fold itself is a pseudo-element, so what's assertable — and what
    // is actually the contract — is which sleeves carry the modifier.
    show();
    const folded = (title: string) =>
      Boolean(tile(title).querySelector(".tile__sleeve--needs"));
    expect(folded("Purple Rain")).toBe(true); // needs a visualizer, a card and signing off
    expect(folded("Aja")).toBe(true); // needs a visualizer
    expect(folded("Blue")).toBe(false); // ready
    expect(folded("Kind of Blue")).toBe(false); // Roadie has it
    expect(folded("Rachel's Greatest Hits")).toBe(false); // stuck
  });

  it("folds the corner whether the sleeve is a cover or a stripe", () => {
    // The wrapper is the whole reason the fold works on both: an <img> can carry no pseudo-element,
    // so a treatment that lived on `.tile__art` would silently apply to un-fetched sleeves only.
    show([
      album({ curatorId: "abc12345", title: "With Art", artwork: "a/b.jpg" }),
      album({ curatorId: "def67890", title: "No Art" }),
    ]);
    for (const t of ["With Art", "No Art"])
      expect(tile(t).querySelector(".tile__sleeve--needs")).toBeTruthy();
    expect(tile("With Art").querySelector("img")).toBeTruthy();
    expect(tile("No Art").querySelector("img")).toBeNull();
  });

  it("lets a record Roadie is holding narrate itself in place", () => {
    show();
    // Not a separate "processing" section, and not the state's name.
    expect(
      within(tile("Kind of Blue")).getByText("FINDING THE SLEEVE…"),
    ).toBeTruthy();
  });

  it("opens the record when a tile is clicked", () => {
    show();
    expect(tile("Purple Rain").getAttribute("href")).toBe("/albums/2k7bxq9m");
  });

  it("keys the cover on the artwork path, so one that lands later actually appears", () => {
    // The grid polls every 3s. With a static src, a cover Roadie writes *after* first paint never
    // shows up and the tile stays a stripe until the page is reloaded (issue #25). The path is the
    // freshness token: it changes when the art lands, busting the cache and clearing the latch.
    show([
      album({
        curatorId: "abc12345",
        title: "Purple Rain",
        artwork: "media/artwork/abc12345.jpg",
      }),
    ]);
    const src = tile("Purple Rain").querySelector("img")!.getAttribute("src")!;
    expect(src).toContain("/api/albums/abc12345/artwork");
    expect(src).toContain(
      `?v=${encodeURIComponent("media/artwork/abc12345.jpg")}`,
    );
  });

  it("falls back to the record's own lights when a cover won't load", () => {
    // The asset records a path, but the file can still be missing or mid-write. A wall of the
    // browser's broken-image glyphs reads as a broken app (the lesson of issue #134).
    show([
      album({
        curatorId: "abc12345",
        title: "Purple Rain",
        artwork: "/covers/abc12345.jpg",
      }),
    ]);
    const img = tile("Purple Rain").querySelector("img")!;
    expect(img).toBeTruthy();
    fireEvent.error(img);
    expect(tile("Purple Rain").querySelector("img")).toBeNull();
    const stripe = tile("Purple Rain").querySelector(
      ".tile__art",
    ) as HTMLElement;
    expect(stripe.style.background).toContain("#4B0082");
  });

  it("never puts a machine state name or an album id on screen", () => {
    show();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/awaiting_|downloading_art|errored|needs_manual/);
    for (const a of LIBRARY) expect(text).not.toContain(a.curatorId);
  });
});

describe("Collection — the stat band", () => {
  it("counts not-complete, ready and not-started separately", () => {
    show();
    const band = within(screen.getByRole("region", { name: /at a glance/i }));
    const cellFor = (label: string) =>
      within(band.getByText(label).closest("div")!);
    expect(cellFor("NOT COMPLETE").getByText("2")).toBeTruthy();
    expect(cellFor("READY").getByText("1")).toBeTruthy();
    expect(cellFor("NOT STARTED").getByText("1")).toBeTruthy();
  });

  it("says what the outstanding work actually is", () => {
    show();
    expect(screen.getByText("two still need a visualizer")).toBeTruthy();
  });

  it("advances to the next statistic when clicked, and says which one it is", () => {
    show();
    const rotator = screen.getByRole("button", {
      name: /show the next statistic/i,
    });
    const first = rotator.textContent;
    fireEvent.click(rotator);
    expect(
      screen.getByRole("button", { name: /show the next statistic/i })
        .textContent,
    ).not.toBe(first);
    expect(screen.getByText(/↻ \d of \d/)).toBeTruthy();
  });
});

describe("Collection — filtering and grouping", () => {
  it("regroups under one heading per need, and drops the empty ones", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /NOT COMPLETE · 2/ }));
    const headings = screen
      .getAllByRole("heading")
      .map((h) => h.textContent ?? "");
    // Both not-complete records are first-need visualizer, so the groups are one heading, not two:
    // the grouped view stays first-need so a sleeve appears once (ADR 0070).
    expect(headings).toEqual(["NEEDS VISUALIZER· 2"]);
    // Nothing has a card or signing off as its *first* need today, so those aren't drawn at all.
    expect(headings.join()).not.toMatch(/NEEDS CARD|NEEDS SIGN-OFF/);
  });

  it("gives a failure its own row, with a sentence and a way out", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /NOT COMPLETE · 2/ }));
    // Scoped to the row rather than the page: the STUCK chip in the filter bar carries the same
    // count, the same way NOT COMPLETE appears in both the stat band and a chip.
    const row = document.querySelector(".stuck") as HTMLElement;
    expect(within(row).getByText("STUCK · 1")).toBeTruthy();
    expect(screen.getByText(/Roadie couldn't find this anywhere/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "FIX IT" })).toBeTruthy();
  });

  it("filters to ready without regrouping", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /READY · 1/ }));
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.queryByText("Purple Rain")).toBeNull();
  });

  it("searches title and artist, case-insensitively", () => {
    show();
    fireEvent.change(screen.getByLabelText(/Search your collection/i), {
      target: { value: "miles" },
    });
    expect(screen.getByText("Kind of Blue")).toBeTruthy();
    expect(screen.queryByText("Purple Rain")).toBeNull();
  });

  it("says so when a search matches nothing, rather than showing a blank wall", () => {
    show();
    fireEvent.change(screen.getByLabelText(/Search your collection/i), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("Nothing matches that")).toBeTruthy();
  });
});

/**
 * One chip per state, and one per need (ADR 0070). The chips are how you sit down to do a batch of
 * one kind of work, which is the thing the three-chip bar could not express.
 */
describe("Collection — a chip per state", () => {
  const chip = (name: RegExp) => screen.getByRole("button", { name });

  it("offers every state a record can be in", () => {
    show();
    for (const name of [
      /^EVERYTHING$/,
      /NOT COMPLETE · 2/,
      /NEEDS VISUALIZER · 2/,
      /NEEDS CARD · 1/,
      /NEEDS SIGN-OFF · 1/,
      /READY · 1/,
      /NOT STARTED · 1/,
      /STUCK · 1/,
    ])
      expect(chip(name)).toBeTruthy();
  });

  it("shows every record that owes the thing, not just the ones it is first for", () => {
    // Purple Rain owes all three, so it belongs under NEEDS CARD as much as under NEEDS
    // VISUALIZER — the point of the chips. Aja has a card, so it does not.
    show();
    fireEvent.click(chip(/NEEDS CARD · 1/));
    expect(screen.getByText("Purple Rain")).toBeTruthy();
    expect(screen.queryByText("Aja")).toBeNull();
  });

  it("labels the tiles with the need you picked, not their first one", () => {
    show();
    fireEvent.click(chip(/NEEDS CARD · 1/));
    expect(within(tile("Purple Rain")).getByText("NEEDS CARD")).toBeTruthy();
    expect(
      within(tile("Purple Rain")).queryByText("NEEDS VISUALIZER"),
    ).toBeNull();
  });

  it("marks the chip you are on, and only that one", () => {
    show();
    fireEvent.click(chip(/NEEDS CARD · 1/));
    expect(chip(/NEEDS CARD · 1/).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^EVERYTHING$/).getAttribute("aria-pressed")).toBe("false");
    expect(chip(/NOT COMPLETE · 2/).getAttribute("aria-pressed")).toBe("false");
  });

  it("reaches the records Roadie is holding, which no work chip includes", () => {
    show();
    fireEvent.click(chip(/NOT STARTED · 1/));
    expect(screen.getByText("Kind of Blue")).toBeTruthy();
    expect(screen.queryByText("Purple Rain")).toBeNull();
  });

  it("shows the stuck ones as rows with a way out, not as tiles", () => {
    show();
    fireEvent.click(chip(/STUCK · 1/));
    expect(screen.getByText(/Roadie couldn't find this anywhere/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "FIX IT" })).toBeTruthy();
    expect(screen.queryByText("Purple Rain")).toBeNull();
  });

  /**
   * The retry roadie-spec §8 has promised all along
   * ([#345](https://github.com/dylanleatham/Marquee/issues/345)): "any album in `errored` or
   * `needs_manual` can be re-enqueued by the human via a UI button". The button went missing when
   * ADR 0052 replaced the nine-state queue with this screen — `api.retry` survived, wired to
   * nothing — so for two months a stuck record's only listed way out was a link to a page that
   * could not un-stick it either.
   */
  it("lets you re-enqueue a stuck record without leaving the collection", async () => {
    show();
    fireEvent.click(chip(/STUCK · 1/));
    fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith("0z4rjc6y"));
  });

  it("says so when the hand-back fails, on the record it failed for", async () => {
    // `AsyncButton` cannot show a failure — it is a <button> — so a handler that doesn't catch
    // leaves it settling back with no explanation, which this repo has taken as a review finding
    // three times. The sentence goes on the row that already explains itself.
    vi.mocked(api.retry).mockRejectedValueOnce(new Error("Roadie is paused"));
    show();
    fireEvent.click(chip(/STUCK · 1/));
    fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));
    const row = document.querySelector(".stuck") as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByText(/Roadie is paused/)).toBeTruthy(),
    );
    // The record's own sentence is still there — the failure is appended, not a replacement.
    expect(within(row).getByText(/couldn't find this anywhere/)).toBeTruthy();
  });

  it("keeps FIX IT beside it — the two answer different failures", () => {
    // A transient failure ("try again in a minute") wants the button; a record that will never
    // resolve upstream wants the page, to be given the artifact by hand. Offering only one of them
    // is what left `art_unavailable` with no way out at all.
    show();
    fireEvent.click(chip(/STUCK · 1/));
    const row = document.querySelector(".stuck") as HTMLElement;
    expect(within(row).getByRole("button", { name: "TRY AGAIN" })).toBeTruthy();
    expect(within(row).getByRole("link", { name: "FIX IT" })).toBeTruthy();
  });

  it("hides STUCK entirely when nothing is stuck", () => {
    // A permanent STUCK · 0 offers a category of failure to a collection that has none. The other
    // chips are the standing vocabulary and stay put at zero.
    show(LIBRARY.filter((a) => a.state !== "errored"));
    expect(screen.queryByRole("button", { name: /STUCK/ })).toBeNull();
    expect(screen.getByRole("button", { name: /READY · 1/ })).toBeTruthy();
  });

  it("says the filter cleared it, rather than blaming a search you didn't type", () => {
    show(LIBRARY.filter((a) => a.curatorId === "5j9wqz1r")); // just the ready one
    fireEvent.click(chip(/NEEDS CARD · 0/));
    expect(screen.getByText("Nothing here right now")).toBeTruthy();
    expect(screen.queryByText(/clear the search/)).toBeNull();
  });
});

describe("Collection — the wall's controls", () => {
  it("reshuffles on demand", () => {
    // Seeded, so the order is stable across the re-renders the poll causes — and only changes when
    // asked. With five records a reshuffle can land on the same order, so this asserts the control
    // is wired and the grid survives it, not that the order definitely differs.
    show();
    const before = screen.getAllByText(/Purple Rain|Aja|Blue/).length;
    fireEvent.click(screen.getByRole("button", { name: "SHUFFLED ↻" }));
    expect(screen.getAllByText(/Purple Rain|Aja|Blue/).length).toBe(before);
  });

  it("cycles the density label", () => {
    show();
    const cycler = () => screen.getByRole("button", { name: /^DENSITY/ });
    expect(cycler().textContent).toBe("DENSITY ▪▪▫");
    fireEvent.click(cycler());
    expect(cycler().textContent).toBe("DENSITY ▪▪▪");
    fireEvent.click(cycler());
    expect(cycler().textContent).toBe("DENSITY ▪▫▫");
  });
});

describe("Collection — states it owes", () => {
  it("says it is loading rather than showing an empty collection", () => {
    show(null);
    expect(screen.getByText(/Loading your collection/)).toBeTruthy();
  });

  it("reports a failed fetch", () => {
    show(null, "Failed to fetch");
    expect(screen.getByText(/Couldn't load your collection/)).toBeTruthy();
  });

  it("offers a first record when there are none", () => {
    show([]);
    expect(screen.getByText("Your collection is empty")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Add your first record/ }),
    ).toBeTruthy();
  });
});

describe("Collection — the shuffle is stable within a visit", () => {
  it("does not reorder when the poll delivers an identical list", () => {
    // A grid that reshuffles under the cursor on every 3s poll would be unusable; the seed is what
    // prevents it. Re-rendering with a new-but-equal array must not move anything.
    const { rerender } = show();
    const order = () =>
      screen
        .getAllByRole("link")
        .map((a) => a.getAttribute("href"))
        .filter(Boolean);
    const first = order();
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <Collection albums={[...LIBRARY]} error={null} status={IDLE} />
      </MemoryRouter>,
    );
    expect(order()).toEqual(first);
  });
});

describe("Collection — the retired keyboard layer", () => {
  it("does not bind j/k or Enter to the grid", () => {
    // The queue's keyboard model went with the queue (ADR 0052). If it comes back it should come
    // back deliberately, with a decision behind it.
    const spy = vi.spyOn(window, "addEventListener");
    show();
    expect(spy.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(
      0,
    );
    spy.mockRestore();
  });
});
