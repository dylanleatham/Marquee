// Roadie's log strip (ADR 0052): a sentence with the album's name in it, expandable, session-only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { recordActivity, resetRoadieLog } from "../roadieLog";
import { RoadieLog } from "./RoadieLog";

beforeEach(() => resetRoadieLog());
afterEach(cleanup);

const titleOf = (id: string) =>
  ({ a1: "Kind of Blue", b2: "Rachel's Greatest Hits" })[id] ?? null;

const fill = () =>
  recordActivity(
    [
      {
        curatorId: "a1",
        from: "generating_palette",
        to: "awaiting_review",
        at: "2026-08-04T19:04:00.000Z",
      },
      {
        curatorId: "b2",
        from: "fetching_metadata",
        to: "errored",
        at: "2026-08-04T18:51:00.000Z",
      },
    ],
    titleOf,
  );

describe("RoadieLog", () => {
  it("says nothing has happened rather than showing an empty strip", () => {
    render(<RoadieLog />);
    expect(screen.getByText(/Nothing yet this session/)).toBeTruthy();
  });

  it("shows the newest entry, naming the album", () => {
    fill();
    render(<RoadieLog />);
    expect(screen.getByText(/Pulled the lights from/)).toBeTruthy();
    expect(screen.getByText("Kind of Blue")).toBeTruthy();
  });

  it("keeps the rest behind a toggle, and says the log is disposable", () => {
    fill();
    render(<RoadieLog />);
    const toggle = screen.getByRole("button", { name: "THE WHOLE LOG" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Cleared when Curator restarts/)).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText(/Cleared when Curator restarts/)).toBeTruthy();
    // The failure is in the panel — but the collection's Stuck group is where it durably lives.
    expect(screen.getByText(/Gave up on/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "HIDE THE LOG" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("opens the panel above the strip, so it expands upward from a pinned dock", () => {
    // The dock sits at the bottom of the window (ADR 0055), so DOM order *is* the direction the
    // panel opens. Rendered after the strip it would expand off the bottom of the screen — visible
    // only as a panel you cannot read, which no other test here would catch.
    fill();
    const { container } = render(<RoadieLog />);
    fireEvent.click(screen.getByRole("button", { name: "THE WHOLE LOG" }));

    const dock = container.querySelector(".roadiedock")!;
    const panel = dock.querySelector(".roadielog__panel")!;
    const strip = dock.querySelector(".roadielog")!;
    expect(panel).toBeTruthy();
    expect(strip).toBeTruthy();
    // Both live in the one dock, and the panel comes first.
    expect(panel.parentElement).toBe(dock);
    expect(strip.parentElement).toBe(dock);
    expect(
      panel.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("never renders an id or a machine state name", () => {
    fill();
    render(<RoadieLog />);
    fireEvent.click(screen.getByRole("button", { name: "THE WHOLE LOG" }));
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("a1");
    expect(text).not.toContain("b2");
    expect(text).not.toMatch(/awaiting_review|errored|fetching_metadata/);
  });
});
