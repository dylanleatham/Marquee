// Roadie's log strip (ADR 0052): a sentence with the album's name in it, expandable, session-only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { recordActivity, resetRoadieLog } from "../roadieLog";
import type { AgentStatus } from "../api";
import { RoadieLog } from "./RoadieLog";

beforeEach(() => resetRoadieLog());

/** Roadie idle with an empty queue — the resting state most of these cases do not care about. */
const idle: AgentStatus = {
  current: null,
  queueDepth: 0,
  paused: false,
  activity: [],
};
const show = (status: AgentStatus | null = idle) =>
  render(<RoadieLog status={status} />);
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
    show();
    expect(screen.getByText(/Nothing yet this session/)).toBeTruthy();
  });

  it("shows the newest entry, naming the album", () => {
    fill();
    show();
    expect(screen.getByText(/Pulled the lights from/)).toBeTruthy();
    expect(screen.getByText("Kind of Blue")).toBeTruthy();
  });

  it("keeps the rest behind a toggle, and says the log is disposable", () => {
    fill();
    show();
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
    const { container } = show();
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
    show();
    fireEvent.click(screen.getByRole("button", { name: "THE WHOLE LOG" }));
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("a1");
    expect(text).not.toContain("b2");
    expect(text).not.toMatch(/awaiting_review|errored|fetching_metadata/);
  });
});

describe("RoadieLog — where Roadie stands", () => {
  // The strip's log line goes still whether Roadie finished or wedged: a record moves through in
  // ~130ms, so a whole sync lands in one minute and then nothing changes. This is the part that says
  // which happened (ADR 0057).
  it("says it is idle when the queue is empty, even with a log full of work", () => {
    fill();
    show();
    expect(screen.getByText("IDLE · NOTHING QUEUED")).toBeTruthy();
    // ...and still shows what it last did, so "idle" is legible as "finished that", not "did nothing".
    expect(screen.getByText(/Pulled the lights from/)).toBeTruthy();
  });

  it("says what is left while Roadie is working", () => {
    show({ current: "a1", queueDepth: 12, paused: false, activity: [] });
    expect(screen.getByText("WORKING · 12 QUEUED")).toBeTruthy();
  });

  it("says paused rather than idle when Roadie is holding off", () => {
    show({ current: null, queueDepth: 4, paused: true, activity: [] });
    expect(screen.getByText("PAUSED")).toBeTruthy();
    expect(screen.queryByText(/IDLE/)).toBeNull();
  });

  it("pulses the dot only while working, and never relies on it", () => {
    // curator-ui-ux §3.4: the word is the signal; the pulse is decoration on top of it. A still dot
    // and a pulsing one are the same shape and near enough the same colour.
    const { container: busy } = render(
      <RoadieLog
        status={{ current: "a1", queueDepth: 1, paused: false, activity: [] }}
      />,
    );
    expect(busy.querySelector(".pp-dot--pulse")).toBeTruthy();
    cleanup();

    const { container: still } = render(<RoadieLog status={idle} />);
    expect(still.querySelector(".pp-dot--pulse")).toBeNull();
    // The dot went quiet, so the words have to carry it alone.
    expect(still.querySelector(".roadielog__standing")?.textContent).toMatch(
      /IDLE/,
    );
  });

  it("claims nothing before the first poll answers", () => {
    show(null);
    expect(screen.queryByText(/IDLE|WORKING|PAUSED/)).toBeNull();
    expect(screen.getByText("CHECKING…")).toBeTruthy();
  });

  it("announces the standing to a screen reader rather than only drawing it", () => {
    const { container } = show();
    const el = container.querySelector(".roadielog__standing");
    expect(el?.getAttribute("role")).toBe("status");
  });
});
