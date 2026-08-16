// The albums-awaiting-a-tag list, as a CSV the Flipper app reads off the SD card (issue #68,
// "Route B"). The FAP has no network, so the flow is export -> copy to
// /ext/apps_data/marquee_tag_writer/pending.csv. See docs/specs/flipper-tag-writer.md §3.

/** One row of the pending list — the same shape `GET /api/tags/pending` returns. */
export type PendingRow = {
  curatorId: string;
  name: string;
  artist: string;
};

/**
 * Strip the characters that would break the reader's line/field split. The FAP parses this with a
 * split on the first two commas (see `parse_csv_line` in `marquee_tag_writer.c`) rather than a full
 * RFC-4180 parser: `name` and `artist` are display-only on a 128px screen, and quote/escape handling
 * in C is a parser bug waiting to happen. Only the leading `curatorId` has to survive exactly, and it
 * is base32 by construction.
 */
const sanitize = (s: string): string =>
  s
    .replace(/[",\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Read back a list this module wrote. Mirrors the FAP's own parser (`parse_csv_line`): split on the
 * first two commas, ignore the header and anything malformed. Tolerant on purpose — a line we cannot
 * make sense of should drop out rather than abort a merge and lose the whole list.
 */
export function parsePendingCsv(text: string): PendingRow[] {
  const rows: PendingRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("curatorId")) continue;
    const first = line.indexOf(",");
    if (first <= 0) continue;
    const curatorId = line.slice(0, first);
    const rest = line.slice(first + 1);
    const second = rest.indexOf(",");
    rows.push({
      curatorId,
      name: second === -1 ? rest : rest.slice(0, second),
      artist: second === -1 ? "" : rest.slice(second + 1),
    });
  }
  return rows;
}

/**
 * The order the on-device menu is read in: by album name, then artist, then `curatorId`. The list is
 * a mix of records already tagged and records still to do, and it grows to `MAX_ALBUMS` (64) — long
 * enough that "where is this record" needs an answer better than "somewhere". Alphabetical gives one:
 * you know where to scroll before you start.
 *
 * Sorted on the *sanitized* fields, so the order matches the `name - artist` label the FAP actually
 * draws rather than the raw metadata behind it. `Intl.Collator` with an explicit locale rather than
 * bare `localeCompare`: case- and accent-insensitive (`the beatles` files with `The Beatles`),
 * numeric so `Vol. 2` precedes `Vol. 10`, and pinned to `en` so the bytes don't depend on the host's
 * locale. Straight alphabetical — a leading `The` sorts under T, because the alternative is a
 * stop-word list that has to agree with what the screen shows.
 *
 * `curatorId` breaks the final tie so the output is a total order: two pressings of "send" on an
 * unchanged list must produce identical bytes, or the read-back comparison in `pushFile` is noise.
 */
const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

export function sortPendingRows(rows: readonly PendingRow[]): PendingRow[] {
  return [...rows].sort(
    (a, b) =>
      collator.compare(sanitize(a.name), sanitize(b.name)) ||
      collator.compare(sanitize(a.artist), sanitize(b.artist)) ||
      collator.compare(a.curatorId, b.curatorId),
  );
}

/**
 * Add `additions` to an existing list, keyed by `curatorId` — pressing "send" twice must not put an
 * album on the Flipper twice. An album already present is **updated in place** (so a renamed album
 * refreshes).
 *
 * The result is re-sorted by `sortPendingRows`, so a card built up one album at a time from the Ship
 * tab reads the same as one written by the batch push, and an unsorted list already on the card is
 * repaired by the next add. Position is stable under a re-send of the same album — only a rename
 * moves a row, which is the point.
 */
export function mergePendingCsv(
  existing: string,
  additions: readonly PendingRow[],
): string {
  const merged = parsePendingCsv(existing);
  for (const row of additions) {
    const at = merged.findIndex((r) => r.curatorId === row.curatorId);
    if (at === -1) merged.push(row);
    else merged[at] = row;
  }
  return pendingCsv(sortPendingRows(merged));
}

/**
 * Render the pending list as `curatorId,name,artist` lines under a header row. Always ends with a
 * newline so appending or concatenating stays well-formed.
 */
export function pendingCsv(rows: readonly PendingRow[]): string {
  const lines = ["curatorId,name,artist"];
  for (const row of rows) {
    lines.push(
      `${row.curatorId},${sanitize(row.name)},${sanitize(row.artist)}`,
    );
  }
  return lines.join("\n") + "\n";
}
