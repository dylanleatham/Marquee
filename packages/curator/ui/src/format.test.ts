import { describe, it, expect } from "vitest";
import {
  STATE_LABEL,
  STEPPER,
  stepperIndex,
  isProcessing,
  relativeTime,
} from "./format";
import type { RoadieState } from "./api";

describe("stepperIndex", () => {
  it("returns -1 while Roadie is still processing (nothing on the stepper yet)", () => {
    expect(stepperIndex("fetching_metadata")).toBe(-1);
    expect(stepperIndex("generating_palette")).toBe(-1);
  });

  it("locates human states on the stepper, with verified last", () => {
    expect(stepperIndex("awaiting_review")).toBe(0);
    expect(stepperIndex("awaiting_verify")).toBe(4);
    expect(stepperIndex("verified")).toBe(STEPPER.length - 1);
  });

  it("returns -1 for off-happy-path states (errored / needs_manual)", () => {
    expect(stepperIndex("errored")).toBe(-1);
    expect(stepperIndex("needs_manual")).toBe(-1);
  });
});

describe("isProcessing", () => {
  it("is true only for Roadie-driven states", () => {
    expect(isProcessing("downloading_art")).toBe(true);
    expect(isProcessing("fresh")).toBe(true);
    expect(isProcessing("awaiting_review")).toBe(false);
    expect(isProcessing("verified")).toBe(false);
  });
});

describe("STATE_LABEL", () => {
  it("has a label for every state the API can return", () => {
    const states: RoadieState[] = [
      "fresh",
      "fetching_metadata",
      "downloading_art",
      "generating_palette",
      "drafting_prompts",
      "awaiting_review",
      "awaiting_video",
      "awaiting_preview",
      "awaiting_tag_write",
      "awaiting_verify",
      "verified",
      "errored",
      "needs_manual",
    ];
    for (const s of states) expect(STATE_LABEL[s]).toBeTruthy();
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  it("formats recent, minutes, hours, and days", () => {
    expect(relativeTime("2026-07-13T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-07-13T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-07-13T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-11T12:00:00.000Z", now)).toBe("2d ago");
  });
  it("returns empty string for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});
