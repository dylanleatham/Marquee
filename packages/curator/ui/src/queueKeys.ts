// What a keystroke means in the queue (curator-ui-ux §9.1), as a pure decision.
//
// Extracted from QueueView for issue #119. The bug there was that the keydown listener closed over
// the row list, so a key pressed before React flushed the effect that re-attached it acted on an
// empty queue — `j` clamped to 0 and `Enter` saw no selection, and the keystroke vanished with no
// feedback. The component now passes live values in from refs; keeping the decision here means the
// clamping rules are testable without racing React's flush order.

/** Fields a shortcut needs to know about the event's target — enough to decide, nothing more. */
export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export type QueueKeyAction =
  | { type: "move"; cursor: number }
  | { type: "open"; curatorId: string }
  | { type: "focusSearch" }
  | { type: "blurTarget" }
  | null;

/** True for a keystroke aimed at a field the user is typing into — never ours to take. */
export function isTyping(t: KeyTarget | null | undefined): boolean {
  if (!t) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable === true
  );
}

/**
 * Decide what a keystroke does, given the queue **as it is right now**.
 *
 * `rows` is the flattened row list in page order and `cursor` the current selection index. Both are
 * parameters rather than captured state precisely because staleness was the bug: with an empty
 * `rows`, `j` clamps to 0 and `Enter` has nothing to open, which is correct for an empty queue and
 * silently wrong for one that has just painted.
 *
 * Returns `null` when the queue should not act — a modifier is held, the user is typing, or the key
 * isn't ours. Escape while typing blurs the field instead, so a search box is always escapable.
 */
export function queueKeyAction(
  key: string,
  {
    rows,
    cursor,
    target,
    modifier = false,
  }: {
    rows: readonly { curatorId: string }[];
    cursor: number;
    target?: KeyTarget | null;
    modifier?: boolean;
  },
): QueueKeyAction {
  const typing = isTyping(target);
  if (key === "Escape" && typing) return { type: "blurTarget" };
  if (typing || modifier) return null;

  const last = Math.max(rows.length - 1, 0);
  if (key === "j" || key === "ArrowDown")
    return { type: "move", cursor: Math.min(cursor + 1, last) };
  if (key === "k" || key === "ArrowUp")
    return { type: "move", cursor: Math.max(cursor - 1, 0) };
  if (key === "Enter") {
    // Read through the same clamp the view uses, so a cursor left past the end by a shrinking list
    // still opens the row the user can see highlighted.
    const row = rows[Math.min(cursor, last)];
    return row ? { type: "open", curatorId: row.curatorId } : null;
  }
  if (key === "/") return { type: "focusSearch" };
  return null;
}
