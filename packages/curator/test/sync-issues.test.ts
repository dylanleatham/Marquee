import { describe, it, expect } from "vitest";
import { replaceIssuesFrom, tagIssue } from "../src/sync-issues.js";

describe("replaceIssuesFrom", () => {
  it("tags what it stores with the service that raised it", () => {
    expect(replaceIssuesFrom([], "Conductor", ["push failed: boom"])).toEqual([
      "Conductor: push failed: boom",
    ]);
    expect(tagIssue("Backdrop", "sync failed: boom")).toBe(
      "Backdrop: sync failed: boom",
    );
  });

  it("replaces only its own service's entries", () => {
    const existing = [
      "Backdrop: sync failed: old",
      "Conductor: push failed: old",
    ];
    expect(
      replaceIssuesFrom(existing, "Conductor", ["push failed: new"]),
    ).toEqual(["Backdrop: sync failed: old", "Conductor: push failed: new"]);
  });

  it("clears only its own service's entries when given none", () => {
    const existing = [
      "Backdrop: sync failed: still broken",
      "Conductor: push failed: fixed now",
    ];
    expect(replaceIssuesFrom(existing, "Conductor", [])).toEqual([
      "Backdrop: sync failed: still broken",
    ]);
  });

  it("is a no-op on an empty list", () => {
    expect(replaceIssuesFrom([], "Backdrop", [])).toEqual([]);
  });

  // Assets written before namespacing carry `"Backdrop sync failed: …"` with no colon. Without this
  // tolerance those entries would never match their owner again and would stick to the album forever.
  it("still recognises the pre-namespacing message form", () => {
    expect(
      replaceIssuesFrom(
        ["Backdrop sync failed: from an old build"],
        "Backdrop",
        [],
      ),
    ).toEqual([]);
  });

  it("does not treat another service's legacy entry as its own", () => {
    const existing = ["Backdrop sync failed: from an old build"];
    expect(replaceIssuesFrom(existing, "Conductor", [])).toEqual(existing);
  });

  it("keeps an unrecognised entry rather than silently dropping it", () => {
    const existing = ["hand-edited note"];
    expect(replaceIssuesFrom(existing, "Backdrop", ["sync failed: x"])).toEqual(
      ["hand-edited note", "Backdrop: sync failed: x"],
    );
  });
});
