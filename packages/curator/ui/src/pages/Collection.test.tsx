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
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AlbumSummary } from "../api";
import { resetRoadieLog } from "../roadieLog";
import { Collection } from "./Collection";

afterEach(() => {
  cleanup();
  resetRoadieLog();
});

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "manual",
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
    lastError: { message: "no match", reason: "spotify_lookup_failed" },
  }),
];

const show = (
  albums: AlbumSummary[] | null = LIBRARY,
  error: string | null = null,
) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Collection albums={albums} error={error} />
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
    // Purple Rain is missing all four; the tile says one thing.
    expect(within(tile("Purple Rain")).getByText("NEEDS LIGHTS")).toBeTruthy();
    expect(within(tile("Purple Rain")).queryByText(/\+\d|\d of 4/)).toBeNull();
    expect(within(tile("Aja")).getByText("NEEDS VISUALIZER")).toBeTruthy();
    expect(within(tile("Blue")).getByText("READY")).toBeTruthy();
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
    expect(screen.getByText("one still needs lights")).toBeTruthy();
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
    expect(headings).toEqual(["NEEDS LIGHTS· 1", "NEEDS VISUALIZER· 1"]);
    // Nothing needs a card or signing off today, so those headings are not drawn at all.
    expect(headings.join()).not.toMatch(/NEEDS CARD|NEEDS SIGN-OFF/);
  });

  it("gives a failure its own row, with a sentence and a way out", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /NOT COMPLETE · 2/ }));
    expect(screen.getByText("STUCK · 1")).toBeTruthy();
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
        <Collection albums={[...LIBRARY]} error={null} />
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
