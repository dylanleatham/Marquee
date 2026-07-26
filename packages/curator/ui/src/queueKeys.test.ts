// The queue's keyboard rules as a decision, independent of React's flush order (issue #119).
//
// The bug these exist to pin down was only ever reproducible as a race — the listener held a stale
// row list for the moment between React committing rows to the DOM and flushing the effect that
// re-attached it. Testing the decision directly makes the rules that were wrong in that window
// (clamping against an empty list, opening nothing) checkable without racing anything.
import { describe, it, expect } from "vitest";
import { queueKeyAction, isTyping } from "./queueKeys";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ curatorId: `id${i}` }));

const act = (
  key: string,
  opts: Partial<Parameters<typeof queueKeyAction>[1]> = {},
) => queueKeyAction(key, { rows: rows(3), cursor: 0, ...opts });

describe("queueKeyAction — movement", () => {
  it("moves down on j and ArrowDown, up on k and ArrowUp", () => {
    expect(act("j", { cursor: 0 })).toEqual({ type: "move", cursor: 1 });
    expect(act("ArrowDown", { cursor: 0 })).toEqual({
      type: "move",
      cursor: 1,
    });
    expect(act("k", { cursor: 2 })).toEqual({ type: "move", cursor: 1 });
    expect(act("ArrowUp", { cursor: 2 })).toEqual({ type: "move", cursor: 1 });
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(act("k", { cursor: 0 })).toEqual({ type: "move", cursor: 0 });
    expect(act("j", { cursor: 2 })).toEqual({ type: "move", cursor: 2 });
  });

  it("pulls a cursor left past the end back onto the last row", () => {
    // A shrinking list (filtering) can leave the cursor beyond the end; k must step back from what
    // is on screen, not from the stale index.
    expect(act("k", { rows: rows(2), cursor: 9 })).toEqual({
      type: "move",
      cursor: 8,
    });
    expect(act("Enter", { rows: rows(2), cursor: 9 })).toEqual({
      type: "open",
      curatorId: "id1",
    });
  });

  it("does nothing harmful on an empty queue", () => {
    expect(act("j", { rows: [], cursor: 0 })).toEqual({
      type: "move",
      cursor: 0,
    });
    expect(act("Enter", { rows: [], cursor: 0 })).toBeNull();
  });

  /**
   * The #119 regression, stated as a rule: the decision is made from the rows passed in, so a
   * handler holding a stale (empty) list is impossible by construction. Before the fix the component
   * captured `ordered.length` in a closure, and this is the case that silently became a no-op.
   */
  it("acts on the rows it is given, not on some earlier list", () => {
    expect(act("j", { rows: rows(0), cursor: 0 })).toEqual({
      type: "move",
      cursor: 0,
    });
    // Same keystroke, same cursor — only the live row list differs, and that must be what decides.
    expect(act("j", { rows: rows(3), cursor: 0 })).toEqual({
      type: "move",
      cursor: 1,
    });
    expect(act("Enter", { rows: rows(3), cursor: 0 })).toEqual({
      type: "open",
      curatorId: "id0",
    });
  });
});

describe("queueKeyAction — what it refuses", () => {
  it("never takes a keystroke aimed at a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"])
      expect(act("j", { target: { tagName } })).toBeNull();
    expect(act("j", { target: { isContentEditable: true } })).toBeNull();
  });

  it("blurs the field on Escape instead of swallowing it", () => {
    expect(act("Escape", { target: { tagName: "INPUT" } })).toEqual({
      type: "blurTarget",
    });
    // Escape outside a field isn't ours — it belongs to whatever else is listening.
    expect(act("Escape")).toBeNull();
  });

  it("leaves modified keystrokes to the browser and the app menu", () => {
    expect(act("j", { modifier: true })).toBeNull();
    expect(act("Enter", { modifier: true })).toBeNull();
  });

  it("ignores keys it doesn't own", () => {
    expect(act("x")).toBeNull();
    expect(act("Tab")).toBeNull();
  });

  it("focuses search on /", () => {
    expect(act("/")).toEqual({ type: "focusSearch" });
  });
});

describe("isTyping", () => {
  it("recognises fields, and nothing else", () => {
    expect(isTyping({ tagName: "INPUT" })).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: "DIV" })).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(undefined)).toBe(false);
  });
});
