// What ⌘K shows for a given query (curator-ui-ux §9.1), as a pure decision.
//
// Same shape as `queueKeys.ts`: the component owns the DOM and the fetch, this owns the ranking, so
// "typing `pnk` finds Pink Floyd" is checkable without rendering anything. The palette ranks two
// kinds of thing — the albums the spec asks for, and a short list of commands (ADR 0043) — and
// albums always sort above commands, so the specified behaviour stays the default one.

/** Albums are what §9.1 asks for; commands are the addition ADR 0043 records. */
export type PaletteGroup = "album" | "command";

/** One candidate row. `run` lives on the component's own type — this module only ranks. */
export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  /** Primary line: album title, or the command's name. */
  label: string;
  /** Secondary line: the artist, or what the command does. Matches, at a small penalty. */
  sublabel?: string;
  /** Unshown synonyms — "preferences" should find Settings even though the word isn't on screen. */
  keywords?: string[];
}

/** Albums are capped so a 200-album library can't bury the commands under one long scroll. */
export const ALBUM_LIMIT = 7;
export const COMMAND_LIMIT = 6;

/** Word starts — a query matching one of these is a better hit than one landing mid-word. */
const isBoundary = (text: string, i: number): boolean =>
  i === 0 || !/[a-z0-9]/.test(text[i - 1] ?? "");

/**
 * Score `query` against `text` as a fuzzy subsequence, or `null` when the letters aren't all there
 * in order. Higher is better.
 *
 * The three things that make a hit feel right, in the order they matter: matching early in the
 * string, matching tightly (`pnk` in "Pink Floyd" beats `pnk` scattered across "Panic Ink"), and
 * landing on word starts (`df` finding "Dark side of the moon" via two initials).
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (!t) return null;

  let score = 1000;
  let first = -1;
  let last = -1;
  let from = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (first === -1) first = at;
    last = at;
    if (isBoundary(t, at)) score += 12;
    from = at + 1;
  }

  // Where it starts, and how far it had to stretch to finish.
  score -= Math.min(first, 40) * 3;
  score -= Math.min(last - first - (q.length - 1), 60) * 4;
  // An exact prefix is what the user almost always meant; give it a decisive edge.
  if (t.startsWith(q)) score += 200;
  return score;
}

/**
 * Best score across an item's fields, or `null` if nothing matched. The sublabel and keywords are
 * discounted so an album whose *title* matches outranks one that only matched on artist — searching
 * "blue" should surface the album called Blue before every album by Blue Öyster Cult.
 */
export function scoreItem(query: string, item: PaletteItem): number | null {
  const scores = [
    scoreMatch(query, item.label),
    ...(item.sublabel != null
      ? [subtract(scoreMatch(query, item.sublabel), 60)]
      : []),
    ...(item.keywords ?? []).map((k) => subtract(scoreMatch(query, k), 120)),
  ].filter((s): s is number => s !== null);
  return scores.length ? Math.max(...scores) : null;
}

const subtract = (score: number | null, penalty: number): number | null =>
  score === null ? null : score - penalty;

/**
 * The rows to show, in display order: matching albums first, then matching commands.
 *
 * **An empty query lists commands only.** Albums need letters to fuzzy-match against, and dumping
 * the whole library into an empty palette would bury the six commands that are the one thing worth
 * showing before the user has typed. Ties break on label so the order never shuffles between
 * renders of the same data.
 */
export function rankPalette<T extends PaletteItem>(
  query: string,
  items: readonly T[],
): T[] {
  const q = query.trim();
  const matched = items
    .filter((i) => i.group !== "album" || q !== "")
    .map((item) => ({ item, score: q ? scoreItem(q, item) : 0 }))
    .filter((r): r is { item: T; score: number } => r.score !== null);
  // With no query every score is 0, and sorting would replace the caller's declared order with an
  // alphabetical one — so the empty palette lists the commands in the order they were written,
  // which is the order they matter in.
  const ranked = q
    ? [...matched].sort(
        (a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label),
      )
    : matched;

  const take = (group: PaletteGroup, limit: number) =>
    ranked
      .filter((r) => r.item.group === group)
      .slice(0, limit)
      .map((r) => r.item);

  return [...take("album", ALBUM_LIMIT), ...take("command", COMMAND_LIMIT)];
}

/**
 * Where the selection lands after a key. Kept here with the ranking because the rule that matters —
 * the cursor is clamped to the list **as it is now**, never a copy captured when the listener was
 * registered — is the one issue #119 was about, and the palette's list changes on every keystroke.
 */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(cursor, length - 1));
}
