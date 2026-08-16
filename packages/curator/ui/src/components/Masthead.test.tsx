// The masthead (ADR 0052): what it says about the collection as a whole, and what it no longer says.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AlbumSummary } from "../api";
import { Masthead } from "./Masthead";

afterEach(cleanup);

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
    genres: [],
    paletteHexes: [],
    hasCardArt: false,
    tagsWritten: false,
    previewApprovedAt: null,
    physicallyVerifiedAt: null,
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const ready = {
  state: "verified" as const,
  hasVideo: true,
  hasCardArt: true,
  tagsWritten: true,
  previewApprovedAt: "2026-08-01T10:00:00.000Z",
  physicallyVerifiedAt: "2026-08-01T11:00:00.000Z",
};

const show = (albums: AlbumSummary[] | null, roadieWorking = false) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Masthead albums={albums} roadieWorking={roadieWorking} />
    </MemoryRouter>,
  );

describe("Masthead", () => {
  it("reports progress across the whole collection, in words as well as a bar", () => {
    show([
      album({ curatorId: "a", ...ready }),
      album({ curatorId: "b" }),
      album({ curatorId: "c" }),
      album({ curatorId: "d" }),
    ]);
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("OF 4 READY")).toBeTruthy();
  });

  it("holds its space rather than showing 0 of 0 before the first fetch lands", () => {
    show(null);
    expect(screen.queryByText(/OF \d+ READY/)).toBeNull();
  });

  it("marks the current screen for assistive tech, not only visually", () => {
    show([]);
    expect(
      screen
        .getByRole("link", { name: "COLLECTION" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "SYSTEM" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("carries all five destinations", () => {
    show([]);
    for (const label of [
      "COLLECTION",
      "ADD A RECORD",
      "DISCOGS",
      "SYSTEM",
      "SETTINGS",
    ])
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
  });

  it("says Roadie is working in words, never with a dot alone", () => {
    show([album({ curatorId: "a" })], true);
    expect(screen.getByText("ROADIE WORKING")).toBeTruthy();
    cleanup();
    show([album({ curatorId: "a" })], false);
    expect(screen.queryByText("ROADIE WORKING")).toBeNull();
  });

  it("draws the brand mark inline, and keeps it out of the accessibility tree", () => {
    // Inline SVG rather than an <img>, so the mark takes the brand block's ink (ADR 0091). It sits
    // beside a wordmark that already reads "Curator" / "MARQUEE COLLECTION", so announcing it again
    // would just be the brand said twice.
    show([]);
    const brand = screen.getByRole("link", { name: /curator/i });
    const mark = brand.querySelector(".masthead__mark");
    expect(mark).toBeTruthy();
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    expect(mark!.querySelector("svg")).toBeTruthy();
    // The old crop pointed an <img> at the logo JPEG and offset it inside an overflow box.
    expect(mark!.querySelector("img")).toBeNull();
  });

  it("no longer offers the command palette or a needs-you count", () => {
    // Both were removed with the keyboard layer (ADR 0052); a stray reintroduction would show here.
    show([album({ curatorId: "a" })]);
    expect(screen.queryByText(/jump/i)).toBeNull();
    expect(screen.queryByText(/needs you/i)).toBeNull();
  });
});
