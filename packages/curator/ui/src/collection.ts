// The collection's arrangement: how it is shuffled, filtered, grouped and counted (ADR 0052).
//
// Pure, no React — every one of these is a decision worth pinning down in a test rather than
// re-deriving inside a component.
import type { AlbumSummary } from "./api";
import {
  NEED_LABEL,
  NEED_ORDER,
  outstandingNeeds,
  recordState,
  type Need,
  type RecordState,
} from "./needs";

/**
 * The four states a record can be in, as the chips name them.
 *
 * These are the `RecordState` kinds spelled exactly — not a parallel vocabulary that has to be kept
 * in step. `visibleTiles` leans on that directly (`t.state.kind === filter`), and a test pins it, so
 * a fifth state cannot be added without the chip row gaining one too.
 */
export type StateFilter = RecordState["kind"];

/**
 * What the collection can be narrowed to: everything, one state, or one outstanding need (ADR 0070).
 *
 * A `Need` here means **every record that still owes that thing**, not the records it happens to be
 * first for — see `visibleTiles`.
 */
export type CollectionFilter = "all" | StateFilter | Need;

const FILTERS: readonly CollectionFilter[] = [
  "all",
  "needs",
  ...NEED_ORDER,
  "ready",
  "roadie",
  "stuck",
];

const isNeedFilter = (f: CollectionFilter): f is Need =>
  (NEED_ORDER as readonly string[]).includes(f);

/**
 * Total, because the value round-trips through the URL and can come back as anything at all —
 * `?filter=banana` must land on the whole collection rather than on an empty grid with every chip
 * unpressed. Same discipline as `step()` below.
 */
export const parseFilter = (raw: string | null): CollectionFilter =>
  (FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as CollectionFilter)
    : "all";

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
 * **A need filter asks "does this record still owe a card?", not "is a card the first thing it
 * owes?"** (ADR 0070). The needs are independent predicates and the whole point is that you may do
 * them in any order; first-need semantics would have hidden a record that wants a card behind the
 * visualizer it also wants, so an afternoon of making cards would clear the chip only to have it
 * refill from records that were owing one the whole time. The cost is that the per-need chips sum to
 * more than NOT COMPLETE — deliberate, and why the groups under NOT COMPLETE stay first-need so that
 * view still shows each record exactly once.
 *
 * A tile matched this way is **relabelled to the need you asked for**, so a grid under NEEDS CARD
 * never contains a tile reading NEEDS VISUALIZER. Under every other filter the tile keeps its own
 * first-outstanding label.
 *
 * Every work filter excludes the records Roadie is still holding and the ones that are stuck: you
 * can't make a card for a record that failed to download, and a tile offering nothing to do is a
 * dead end in a list you are working down. Both have chips of their own instead.
 */
export function visibleTiles(
  albums: readonly AlbumSummary[],
  {
    filter,
    query,
    seed,
  }: { filter: CollectionFilter; query: string; seed: number },
): Tile[] {
  const tiles = seededShuffle(albums, seed)
    .filter((a) => matchesQuery(a, query))
    .map((album) => ({ album, state: recordState(album) }));
  if (filter === "all") return tiles;
  if (isNeedFilter(filter))
    return tiles
      .filter(
        (t) =>
          t.state.kind === "needs" &&
          outstandingNeeds(t.album).includes(filter),
      )
      .map(({ album }) => ({ album, state: { kind: "needs", need: filter } }));
  return tiles.filter((t) => t.state.kind === filter);
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
  /** How many records each need is the *first* outstanding one for — what the groups hold. */
  byNeed: Record<Need, number>;
  /**
   * How many records still owe each need **at all**. Adds up to more than `notComplete`, because a
   * record missing both a visualizer and a card is counted under both — this is what the per-need
   * chips say, and it matches what clicking one shows you.
   */
  byOutstanding: Record<Need, number>;
}

/** Built from `NEED_ORDER` rather than written out, so a new need cannot be missed here. */
const zeroPerNeed = (): Record<Need, number> =>
  Object.fromEntries(NEED_ORDER.map((n) => [n, 0])) as Record<Need, number>;

export function collectionCounts(
  albums: readonly AlbumSummary[],
): CollectionCounts {
  const byNeed = zeroPerNeed();
  const byOutstanding = zeroPerNeed();
  let notComplete = 0;
  let ready = 0;
  let notStarted = 0;
  let stuck = 0;
  for (const a of albums) {
    const s = recordState(a);
    if (s.kind === "needs") {
      notComplete++;
      byNeed[s.need]++;
      for (const n of outstandingNeeds(a)) byOutstanding[n]++;
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
    byOutstanding,
  };
}

/** One chip in the filter bar. `count === null` means the chip carries no number. */
export interface FilterChip {
  value: CollectionFilter;
  label: string;
  count: number | null;
}

/**
 * The filter bar, in order: everything, the outstanding work narrowed from broad to specific, then
 * the three states you can't act on.
 *
 * EVERYTHING carries no count because the search placeholder already says how many records there
 * are, and STUCK is dropped entirely when nothing is stuck — the other chips are the standing
 * vocabulary of the collection and read fine at zero, but a permanent STUCK · 0 offers a category of
 * failure to a collection that has none.
 */
export const filterChips = (c: CollectionCounts): FilterChip[] => [
  { value: "all", label: "EVERYTHING", count: null },
  { value: "needs", label: "NOT COMPLETE", count: c.notComplete },
  ...NEED_ORDER.map((n) => ({
    value: n,
    label: NEED_LABEL[n],
    count: c.byOutstanding[n],
  })),
  { value: "ready", label: "READY", count: c.ready },
  { value: "roadie", label: "NOT STARTED", count: c.notStarted },
  ...(c.stuck
    ? [{ value: "stuck" as const, label: "STUCK", count: c.stuck }]
    : []),
];

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
 *
 * Counted first-need (`byNeed`), not `byOutstanding`, because it sits directly under the NOT
 * COMPLETE total: a detail line claiming more records than the number above it reads as a bug.
 */
export function notCompleteDetail(counts: CollectionCounts): string {
  if (!counts.notComplete) return "nothing outstanding";
  const biggest = NEED_ORDER.reduce((best, n) =>
    counts.byNeed[n] > counts.byNeed[best] ? n : best,
  );
  const n = counts.byNeed[biggest];
  // Same rule as NEED_LABEL: name the act, not the artifact.
  const what = {
    visualizer: "a visualizer",
    card: "a card",
    tags: "signing off",
  }[biggest];
  return `${spell(n)} still ${n === 1 ? "needs" : "need"} ${what}`;
}
