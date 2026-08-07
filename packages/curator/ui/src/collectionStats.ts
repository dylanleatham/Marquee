// The rotating statistic in the collection's stat band (ADR 0052) — the one cell that isn't about
// work outstanding. It is there to make the collection feel like a collection: you click it and it
// tells you something about what you own.
//
// Pure, no React.
import type { AlbumSummary } from "./api";

export interface StatBar {
  label: string;
  /** 0–100. Floored so a value of 1 is still a visible bar rather than a hairline. */
  height: number;
  /** The largest bar, drawn in the accent. Exactly one per chart. */
  hot: boolean;
}

export type Stat =
  | { key: string; label: string; kind: "bars"; bars: StatBar[] }
  | { key: string; label: string; kind: "text"; big: string; sub: string };

const DECADES = ["50s", "60s", "70s", "80s", "90s", "00s+"] as const;

const decadeOf = (year: number): string =>
  year < 1960
    ? "50s"
    : year < 1970
      ? "60s"
      : year < 1980
        ? "70s"
        : year < 1990
          ? "80s"
          : year < 2000
            ? "90s"
            : "00s+";

/** Descending count per distinct value, ties broken alphabetically so the order is deterministic. */
function tally(values: readonly string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

const bars = (
  key: string,
  label: string,
  rows: Array<[string, number]>,
): Stat => {
  const max = Math.max(...rows.map(([, v]) => v), 1);
  return {
    key,
    label,
    kind: "bars",
    bars: rows.map(([l, v]) => ({
      label: l,
      height: Math.max(6, (v / max) * 100),
      hot: v === max && v > 0,
    })),
  };
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Every statistic there is data for, in a stable order.
 *
 * The design calls for five. **Top label is missing on purpose**: an album asset has no `label`
 * field today (flagged in ADR 0052), so the statistic cannot be computed and a cell reading "—"
 * would be worse than one fewer. Building the pool from what has data means the rotation becomes
 * five on its own the day the field lands, with no change here.
 */
export function statsFor(albums: readonly AlbumSummary[]): Stat[] {
  const out: Stat[] = [];
  const years = albums
    .map((a) => a.year)
    .filter((y): y is number => typeof y === "number");

  if (years.length) {
    const counts = new Map<string, number>(DECADES.map((d) => [d, 0]));
    for (const y of years)
      counts.set(decadeOf(y), (counts.get(decadeOf(y)) ?? 0) + 1);
    out.push(bars("decade", "BY DECADE", [...counts.entries()]));
  }

  const genres = tally(
    albums.flatMap((a) => (a.genres.length ? [a.genres[0]!] : [])),
  ).slice(0, 6);
  if (genres.length) out.push(bars("genre", "GENRE BREAKDOWN", genres));

  const artists = tally(albums.map((a) => a.artist).filter(Boolean));
  const top = artists[0];
  if (top)
    out.push({
      key: "artist",
      label: "TOP ARTIST",
      kind: "text",
      big: top[0],
      sub: `${top[1]} ${plural(top[1], "record", "records")} — more than anyone else`,
    });

  if (years.length > 1) {
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    const oldest = albums.find((a) => a.year === lo);
    const newest = albums.find((a) => a.year === hi);
    if (lo !== hi && oldest && newest)
      out.push({
        key: "span",
        label: "OLDEST AND NEWEST",
        kind: "text",
        big: `${lo} → ${hi}`,
        sub: `${oldest.title} to ${newest.title}`,
      });
  }

  return out;
}
