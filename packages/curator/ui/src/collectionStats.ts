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
  // `hot` is the *first* row holding the max, not every row holding it. The type promises exactly
  // one accent bar per chart, and hue families tie far more readily than decades do — two families
  // at three records each is an ordinary collection, not a corner case. Rows arrive in a
  // deterministic order (a fixed axis, or count-then-alphabetical out of `tally`), so "first" is
  // stable across renders rather than a coin toss.
  let claimed = false;
  return {
    key,
    label,
    kind: "bars",
    bars: rows.map(([l, v]) => {
      const hot = v === max && v > 0 && !claimed;
      if (hot) claimed = true;
      return { label: l, height: Math.max(6, (v / max) * 100), hot };
    }),
  };
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The hue families a sleeve can land in, in spectrum order, with MONO last because it is the
 * absence of a hue rather than a place on the wheel.
 *
 * **The family is named in the bar's label, never carried only by the bar's colour.** The chart
 * draws in ink and accent like every other one here, so a reader who cannot separate red from green
 * still reads this stat off its labels. It is also why the families are coarse — six names a person
 * says out loud, not twelve a colour picker would.
 *
 * Every name is five characters or fewer, and that is load-bearing rather than a style choice. All
 * seven families present is an ordinary state for a large collection, and the rotator is drawn for
 * six (`styles.css`: about 35px a column on an 864px window). A seventh bar narrows the column to
 * 28.4px, which is the width the rule is actually measured against: at that width, in a browser at
 * 864px, a five-character name sits on one line and a six-character one ("ORANGE", "YELLOW",
 * "PURPLE") breaks mid-word into ORANG/E. That is the readability floor issue #339 was about, and a
 * label is this chart's only channel for a reader who cannot separate the hues.
 *
 * Below about 800px even five characters wrap (measured: 23.8px a column at 768px, wrapping AMBER
 * and GREEN). Nothing spills or overlaps there — it degrades exactly as GENRE BREAKDOWN already
 * does at that width — so the floor is respected rather than newly broken.
 */
const HUE_FAMILIES = [
  "RED",
  "AMBER",
  "GOLD",
  "GREEN",
  "BLUE",
  "PLUM",
  "MONO",
] as const;

type HueFamily = (typeof HUE_FAMILIES)[number];

/** `#rgb` or `#rrggbb` to `[r, g, b]` in 0–1, or null for anything that isn't one. */
function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = Number.parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Which family a sleeve's dominant colour belongs to.
 *
 * A near-grey, a near-black and a near-white are all MONO: their hue is arithmetically real but
 * perceptually meaningless, and a black sleeve reported as GREEN because its ink is two percent off
 * is a lie the chart cannot recover from.
 */
export function hueFamily(hex: string): HueFamily | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || l < 0.08 || l > 0.95) return "MONO";

  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;

  if (h < 15 || h >= 345) return "RED";
  if (h < 45) return "AMBER";
  if (h < 70) return "GOLD";
  if (h < 170) return "GREEN";
  if (h < 260) return "BLUE";
  return "PLUM";
}

/** Distinct genres, compared case-insensitively — "Jazz" and "jazz" are one genre, not two. */
const genreKey = (g: string) => g.trim().toLowerCase();

/**
 * Every statistic there is data for, in a stable order.
 *
 * **Top label is missing on purpose**: an album asset has no `label` field today (flagged in
 * ADR 0052), so the statistic cannot be computed and a cell reading "—" would be worse than one
 * fewer. Building the pool from what has data means the rotation gains it the day the field lands,
 * with no change here.
 *
 * The two texture statistics — sleeve palette and genre reach — are held to a floor rather than
 * merely to "has data". "1 genre, 1 of them on a single record" is arithmetically true and says
 * nothing, and a chart of one bar is not a chart. A statistic that cannot be interesting yet is
 * left out until it can be.
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

  // The wall's colour, read off each record's dominant light rather than its cover. `paletteHexes`
  // is what the grid already draws a coverless sleeve with, so the chart matches the wall you are
  // looking at even before Roadie has fetched the art.
  const families = albums.flatMap((a) => {
    const f = a.paletteHexes[0] ? hueFamily(a.paletteHexes[0]) : null;
    return f ? [f] : [];
  });
  const counted = new Map<HueFamily, number>();
  for (const f of families) counted.set(f, (counted.get(f) ?? 0) + 1);
  // An empty family is dropped, where an empty *decade* is kept. A decade you own nothing from is a
  // gap in a timeline and worth seeing; a colour you own nothing in is not a gap in anything. It
  // also keeps the chart inside the six-bar budget the cell is drawn for in every collection but
  // the one spanning the whole spectrum.
  const paletteRows = HUE_FAMILIES.filter((f) => counted.get(f)).map(
    (f) => [f, counted.get(f)!] as [string, number],
  );
  if (families.length >= 4 && paletteRows.length >= 2)
    out.push(bars("palette", "SLEEVE PALETTE", paletteRows));

  // Reach counts *every* genre on a record, where GENRE BREAKDOWN counts only the first. That is the
  // point of the pair: one is the shape of the collection's centre, this is the size of its tail.
  // Discogs merges genres and styles into this single list (`discogs/client.ts`), so the tail is
  // mostly styles — which is what makes it long enough to be worth counting.
  const genreCounts = new Map<string, number>();
  for (const a of albums)
    for (const g of new Set(a.genres.map(genreKey).filter(Boolean)))
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  const distinct = genreCounts.size;
  const once = [...genreCounts.values()].filter((n) => n === 1).length;
  if (distinct >= 3)
    out.push({
      key: "reach",
      label: "GENRE REACH",
      kind: "text",
      big: `${distinct} genres`,
      sub: `${once} of them on ${plural(once, "a single record", "one record each")}`,
    });

  return out;
}
