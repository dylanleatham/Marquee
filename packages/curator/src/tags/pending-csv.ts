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
 * Add `additions` to an existing list, keyed by `curatorId` — pressing "send" twice must not put an
 * album on the Flipper twice. An album already present is **updated in place** (so a renamed album
 * refreshes) and keeps its position, so the on-device menu doesn't reshuffle under you.
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
  return pendingCsv(merged);
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
