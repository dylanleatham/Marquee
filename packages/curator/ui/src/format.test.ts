// What survives of the queue's presentation helpers (ADR 0052). The `stepperIndex` and `STATE_LABEL`
// cases went with the five-step score and the thirteen-state label map — the UI no longer names a
// machine state, so a test asserting every state has a user-facing label would be asserting the
// opposite of the rule.
import { describe, it, expect } from "vitest";
import { isProcessing, relativeTime, promptIsStale } from "./format";

describe("isProcessing", () => {
  it("is true only for Roadie-driven states", () => {
    expect(isProcessing("downloading_art")).toBe(true);
    expect(isProcessing("fresh")).toBe(true);
    expect(isProcessing("awaiting_review")).toBe(false);
    expect(isProcessing("verified")).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  it("formats recent, minutes, hours, and days", () => {
    expect(relativeTime("2026-07-13T11:59:40.000Z", now)).toBe("a moment ago");
    expect(relativeTime("2026-07-13T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-07-13T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-11T12:00:00.000Z", now)).toBe("2d ago");
  });
  it("returns empty string for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("promptIsStale", () => {
  it("is true when the palette was regenerated after the prompt was drafted", () => {
    expect(promptIsStale("2026-07-13T00:00:01Z", "2026-07-13T00:00:00Z")).toBe(
      true,
    );
  });

  it("is false when the prompt was drafted at or after the palette", () => {
    expect(promptIsStale("2026-07-13T00:00:00Z", "2026-07-13T00:00:00Z")).toBe(
      false,
    );
    expect(promptIsStale("2026-07-13T00:00:00Z", "2026-07-13T00:00:05Z")).toBe(
      false,
    );
  });

  it("is false when either timestamp is missing (nothing to compare)", () => {
    expect(promptIsStale(undefined, "2026-07-13T00:00:00Z")).toBe(false);
    expect(promptIsStale("2026-07-13T00:00:00Z", undefined)).toBe(false);
    expect(promptIsStale(undefined, undefined)).toBe(false);
  });
});
