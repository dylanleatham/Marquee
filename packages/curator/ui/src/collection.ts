// The collection's arrangement: how it is shuffled, filtered, grouped and counted (ADR 0052).
//
// Pure, no React — every one of these is a decision worth pinning down in a test rather than
// re-deriving inside a component.
import type { AlbumSummary } from "./api";
import {
  NEED_LABEL,
  NEED_ORDER,
  recordState,
  type Need,
  type RecordState,
} from "./needs";

export type CollectionFilter = "all" | "needs" | "ready";

/** One record as the grid draws it — the summary plus the state it reads as. */
export interface Tile {
  album: AlbumSummary;
  state: RecordState;
}

/** The three column counts the density cycler steps through. */
export const DENSITIES = [5, 7, 9] as const;

/**
 * Wrap any integer into the cycle. Total because the value round-trips through the URL, where it can
 * come back as anything at all — a grid with `repeat(undefined, …)` columns is a blank screen.
 */
const step = (i: number): number =>
  Number.isFinite(i)
    ? ((Math.trunc(i) % DENSITIES.length) + DENSITIES.length) % DENSITIES.length
    : 1;

/** DENSITY ▪▫▫ / ▪▪▫ / ▪▪▪ — the cycler says how coarse it is without needing a number. */
export const densityLabel = (i: number): string =>
  ["DENSITY ▪▫▫", "DENSITY ▪▪▫", "DENSITY ▪▪▪"][step(i)]!;

export const densityColumns = (i: number): number => DENSITIES[step(i)]!;

/**
 * Order is shuffled on every visit — the collection is a wall to browse, not a list to work down,
 * and a stable order means you only ever look at the same nine records.
 *
 * Seeded rather than `Math.random()` per render: within a visit the order must be stable (React
 * re-renders on every poll tick, and a grid that reshuffles under the cursor is unusable), between
 * visits it must differ. SHUFFLED ↻ reseeds.
 *
 * A plain LCG, not `crypto`: this decides where a record sits on a wall.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = Math.floor(Math.abs(seed) * 10000) % 233280 || 1;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Case-insensitive match on title + artist — the only search the collection has. */
export const matchesQuery = (a: AlbumSummary, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !q || `${a.title} ${a.artist}`.toLowerCase().includes(q);
};

/**
 * The tiles a given filter and query put on screen, in shuffled order.
 *
 * `needs` and `ready` both exclude the records Roadie is still holding: neither is true of them yet,
 * and a record that appears under "not complete" but offers nothing to do is a dead end.
 */
export function visibleTiles(
  albums: readonly AlbumSummary[],
  {
    filter,
    query,
    seed,
  }: { filter: CollectionFilter; query: string; seed: number },
): Tile[] {
  return seededShuffle(albums, seed)
    .filter((a) => matchesQuery(a, query))
    .map((album) => ({ album, state: recordState(album) }))
    .filter((t) => {
      if (filter === "needs") return t.state.kind === "needs";
      if (filter === "ready") return t.state.kind === "ready";
      return true;
    });
}

export interface NeedGroup {
  need: Need;
  label: string;
  tiles: Tile[];
}

/**
 * Regroup under one heading per need. **Empty groups are not rendered at all** — a heading with
 * nothing under it reads as a category you have failed to clear, when in fact you have.
 */
export function groupByNeed(tiles: readonly Tile[]): NeedGroup[] {
  return NEED_ORDER.map((need) => ({
    need,
    label: NEED_LABEL[need],
    tiles: tiles.filter(
      (t) => t.state.kind === "needs" && t.state.need === need,
    ),
  })).filter((g) => g.tiles.length > 0);
}

/** The records that failed — their own row, below the groups, because a failure isn't a missing asset. */
export const stuckTiles = (tiles: readonly Tile[]): Tile[] =>
  tiles.filter((t) => t.state.kind === "stuck");

export interface CollectionCounts {
  total: number;
  notComplete: number;
  ready: number;
  /** Roadie hasn't got to them yet — counted apart from "not complete", which implies you can act. */
  notStarted: number;
  stuck: number;
  /** How many records each need is the *first* outstanding one for. */
  byNeed: Record<Need, number>;
}

export function collectionCounts(
  albums: readonly AlbumSummary[],
): CollectionCounts {
  const byNeed: Record<Need, number> = {
    lights: 0,
    visualizer: 0,
    card: 0,
    tags: 0,
  };
  let notComplete = 0;
  let ready = 0;
  let notStarted = 0;
  let stuck = 0;
  for (const a of albums) {
    const s = recordState(a);
    if (s.kind === "needs") {
      notComplete++;
      byNeed[s.need]++;
    } else if (s.kind === "ready") ready++;
    else if (s.kind === "roadie") notStarted++;
    else stuck++;
  }
  return {
    total: albums.length,
    notComplete,
    ready,
    notStarted,
    stuck,
    byNeed,
  };
}

const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** Small counts read better spelled out in a sentence; past ten, the digit is clearer. */
const spell = (n: number): string => WORDS[n] ?? String(n);

/**
 * The one-line detail under NOT COMPLETE — the biggest single thing standing between the collection
 * and the stand, as a sentence. Ties break in reading order, which is what NEED_ORDER already is.
 */
export function notCompleteDetail(counts: CollectionCounts): string {
  if (!counts.notComplete) return "nothing outstanding";
  const biggest = NEED_ORDER.reduce((best, n) =>
    counts.byNeed[n] > counts.byNeed[best] ? n : best,
  );
  const n = counts.byNeed[biggest];
  // Same rule as NEED_LABEL: name the act, not the artifact. "still need lights" read as "have no
  // lights", which is false the moment Roadie finishes — they have a palette and want your eyes.
  const what = {
    lights: "a look",
    visualizer: "a visualizer",
    card: "a card",
    tags: "signing off",
  }[biggest];
  return `${spell(n)} still ${n === 1 ? "needs" : "need"} ${what}`;
}
