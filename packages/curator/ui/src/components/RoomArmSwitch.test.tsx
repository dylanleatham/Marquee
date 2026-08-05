// The room-arm switch (ADR 0028), now living in the room's own top bar rather than the app-wide
// status bar (ADR 0052).
//
// This control decides whether Curator touches lights and speakers in a room that may have other
// people in it, so the two things worth pinning down are that it *says* which posture it is in —
// never signalling by the dot alone — and that clicking it really flips the shared store the
// hardware gates read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { setRoomArm, resetRoomArmCache } from "../roomArm";
import { RoomArmSwitch } from "./RoomArmSwitch";

beforeEach(() => {
  localStorage.clear();
  resetRoomArmCache();
});
afterEach(cleanup);

const swtch = () => screen.getByRole("switch");

describe("RoomArmSwitch", () => {
  it("defaults to bench, and says so in words", () => {
    render(<RoomArmSwitch />);
    expect(swtch().textContent).toContain("Bench only");
    expect(swtch().getAttribute("aria-checked")).toBe("false");
  });

  it("carries its state as text, not only as a coloured dot", () => {
    // curator-ui-ux §3.4. The dot is decoration; removing the word would make the posture
    // unreadable to this project's own user.
    setRoomArm("live");
    render(<RoomArmSwitch />);
    expect(swtch().textContent).toContain("In the room");
    expect(
      swtch().querySelector(".room-arm__dot")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("flips the shared posture on click, with no confirm dialog", () => {
    // The switch *is* the deliberate act — a confirm step would make it something you dismiss.
    render(<RoomArmSwitch />);
    fireEvent.click(swtch());
    expect(swtch().getAttribute("aria-checked")).toBe("true");
    expect(swtch().textContent).toContain("In the room");
    expect(localStorage.getItem("marquee.roomArm")).toBe("live");

    fireEvent.click(swtch());
    expect(swtch().getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("marquee.roomArm")).toBe("bench");
  });

  it("explains what arming will actually do, in both postures", () => {
    render(<RoomArmSwitch />);
    expect(swtch().getAttribute("title")).toMatch(
      /nothing here will touch the room/i,
    );
    fireEvent.click(swtch());
    expect(swtch().getAttribute("title")).toMatch(
      /real lights, display and Sonos/i,
    );
  });
});
