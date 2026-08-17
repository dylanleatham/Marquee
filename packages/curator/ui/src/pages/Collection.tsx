import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type AgentStatus, type AlbumSummary } from "../api";
import { artworkSrc, AsyncButton } from "../components/common";
import { errorMessage } from "../errors";
import {
  collectionCounts,
  densityColumns,
  densityLabel,
  filterChips,
  groupByNeed,
  notCompleteDetail,
  parseFilter,
  stuckTiles,
  visibleTiles,
  type Tile,
} from "../collection";
import { statsFor, type Stat } from "../collectionStats";
import { roadieNarration, stateLabel } from "../needs";
import { RoadieLog } from "../components/RoadieLog";

/**
 * The collection (ADR 0052) — every record you own, art-first, in a shuffled grid.
 *
 * It replaces `QueueView`, which showed only work-in-progress, grouped into nine machine states, in
 * a fixed order. The queue survives here as one filter chip.
 *
 * `filter`, `q` and `density` live in the URL so a session survives a reload; the shuffle seed and
 * the open log deliberately do not — a fresh visit is meant to look different.
 */

const hatch = (hexes: string[]): string | undefined => {
  const [a, b] = [hexes[0], hexes[1] ?? hexes[0]];
  return a && b
    ? `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`
    : undefined;
};

/**
 * The tile's square. Real cover art when there is any; otherwise a two-tone stripe built from the
 * record's own lights, so a grid of un-fetched sleeves still reads as a wall of records.
 *
 * The state treatment is an `outline`, never a `border`, so it cannot move the layout.
 *
 * A cover that fails to load falls back to the stripe rather than to the browser's broken-image
 * glyph — the same lesson as issue #134. The asset records a path, but the file can still be missing
 * or mid-write, and a wall of broken glyphs reads as a broken app.
 *
 * The art is always wrapped, whatever the state, so the DOM has one shape: the wrapper is what
 * carries the not-complete fold (ADR 0054), and an `<img>` can hold no pseudo-element of its own.
 */
function TileArt({ tile }: { tile: Tile }) {
  const { album, state } = tile;
  const [broken, setBroken] = useState(false);
  // Roadie may write the cover a moment after the row says there is one; a fresh path is a fresh
  // chance, so the latch clears rather than sticking for the life of the tile.
  useEffect(() => setBroken(false), [album.artwork]);
  const modifier =
    state.kind === "ready"
      ? ""
      : state.kind === "roadie"
        ? " tile__art--roadie"
        : state.kind === "stuck"
          ? " tile__art--stuck"
          : " tile__art--needs";
  const className = `tile__art${modifier}`;

  const art =
    state.kind === "stuck" ? (
      <div className={className} aria-hidden="true">
        ?
      </div>
    ) : album.artwork && !broken ? (
      /* The artwork path is the freshness token here (the list carries no contentHash): it changes
         when Roadie writes the cover, which both busts the cache and clears the `broken` latch, so a
         tile recovers in place instead of staying a stripe until the page is reloaded (issue #25). */
      <img
        className={className}
        src={artworkSrc(album.curatorId, album.artwork)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    ) : (
      <div
        className={className}
        style={{ background: hatch(album.paletteHexes) }}
        aria-hidden="true"
      />
    );

  return (
    <span
      className={`tile__sleeve${state.kind === "needs" ? " tile__sleeve--needs" : ""}`}
    >
      {art}
    </span>
  );
}

function RecordTile({ tile }: { tile: Tile }) {
  const { album, state } = tile;
  const label =
    state.kind === "roadie" ? roadieNarration(album.state) : stateLabel(state);
  return (
    <Link to={`/albums/${album.curatorId}`} className="tile">
      <TileArt tile={tile} />
      <span className="tile__title">{album.title || "Untitled"}</span>
      <span className="tile__byline">
        {album.year ? `${album.artist} · ${album.year}` : album.artist}
      </span>
      <span
        className={`tile__state${state.kind === "ready" ? " tile__state--ready" : ""}`}
      >
        {label}
      </span>
    </Link>
  );
}

/** The way in for a record you don't own yet — the last cell of the grid, not a button elsewhere. */
const AddTile = () => (
  <Link to="/add" className="tile tile--add">
    <span className="tile__art" aria-hidden="true">
      +
    </span>
    <span className="tile__title">Add a record</span>
    <span className="tile__byline">search, or type it in</span>
  </Link>
);

function StatCell({
  stat,
  which,
  onAdvance,
}: {
  stat: Stat;
  which: string;
  onAdvance: () => void;
}) {
  return (
    <button
      type="button"
      className="statband__rotator"
      onClick={onAdvance}
      aria-label={`${stat.label} — show the next statistic`}
    >
      <span className="statband__rotator-head">
        <span className="pp-label">{stat.label}</span>
        <span className="statband__which">↻ {which}</span>
      </span>
      {stat.kind === "bars" ? (
        <span className="statband__body">
          <span className="statband__bars">
            {stat.bars.map((b) => (
              <span
                key={b.label}
                className={`statband__bar${b.hot ? " statband__bar--hot" : ""}`}
                style={{ height: `${b.height}%` }}
              />
            ))}
          </span>
          <span className="statband__bar-labels">
            {stat.bars.map((b) => (
              <span key={b.label} className="statband__bar-label">
                {b.label}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <span className="statband__body">
          <span className="statband__big">{stat.big}</span>
          <span className="statband__sub">{stat.sub}</span>
        </span>
      )}
    </button>
  );
}

export function Collection({
  albums,
  error,
  status,
}: {
  albums: AlbumSummary[] | null;
  error: string | null;
  /** Roadie's live standing, polled once in App and passed down — the strip says whether it is
   * still working or genuinely done (ADR 0057). */
  status: AgentStatus | null;
}) {
  const [params, setParams] = useSearchParams();
  // Reshuffled per visit, not per render: React re-renders on every poll tick, and a grid that
  // reorders under the cursor is unusable.
  const [seed, setSeed] = useState(() => Math.random());
  // Which of the statistics is showing. Random on mount so the collection tells you something
  // different each time you sit down, rather than always opening on decades.
  const [statOffset, setStatOffset] = useState(() =>
    Math.floor(Math.random() * 5),
  );
  /** A failed hand-back, against the record it failed for. See `retry` below. */
  const [retryProblem, setRetryProblem] = useState<{
    id: string;
    why: string;
  } | null>(null);

  const filter = parseFilter(params.get("filter"));
  const query = params.get("q") ?? "";
  const density = Number(params.get("density") ?? 1);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const counts = useMemo(() => collectionCounts(albums ?? []), [albums]);
  const stats = useMemo(() => statsFor(albums ?? []), [albums]);
  const tiles = useMemo(
    () => visibleTiles(albums ?? [], { filter, query, seed }),
    [albums, filter, query, seed],
  );
  // Stuck records answer to the search but not to the filter chips: they are the one thing here you
  // can't work on until it's dealt with, so hiding them behind a chip loses them.
  const stuck = useMemo(
    () =>
      stuckTiles(visibleTiles(albums ?? [], { filter: "all", query, seed })),
    [albums, query, seed],
  );

  /**
   * Hand a stuck record back to Roadie (roadie-spec §8). `AsyncButton` cannot show a failure — it is
   * a `<button>` — so the rejection is caught here and appended to that record's own sentence, which
   * is already the place this row explains itself. Keyed by id so a failure can't label the wrong
   * record on a collection with several stuck.
   *
   * No re-poll: `albums` refreshes every 3s from App, so the row redraws when Roadie takes it.
   */
  const retry = async (curatorId: string) => {
    setRetryProblem(null);
    try {
      await api.retry(curatorId);
    } catch (err) {
      setRetryProblem({ id: curatorId, why: errorMessage(err) });
    }
  };

  if (error)
    return (
      <main className="collection">
        <p className="pp-error">Couldn&apos;t load your collection: {error}</p>
      </main>
    );
  if (!albums)
    return (
      <main className="collection">
        <p className="pp-loading">Loading your collection…</p>
      </main>
    );

  const grouped = filter === "needs";
  /**
   * The stuck row shows up in two situations, drawn the same way both times: under the groups while
   * you work through NOT COMPLETE — where it would otherwise be invisible, since no work chip
   * includes a failed record — and as the entire page when you pick STUCK. It is a sentence and a way
   * out rather than a tile, which is why STUCK doesn't just fall through to the grid.
   */
  const stuckOnly = filter === "stuck";
  const stuckRow = stuckOnly ? tiles : grouped ? stuck : [];
  const columns = `repeat(${densityColumns(density)}, minmax(0, 1fr))`;
  const stat = stats.length ? stats[statOffset % stats.length]! : null;

  return (
    <main className="collection">
      <section className="statband" aria-label="Your collection at a glance">
        <div className="statband__cell">
          <p className="pp-label pp-label--accent">NOT COMPLETE</p>
          <p className="statband__n statband__n--accent">
            {counts.notComplete}
          </p>
          <p className="statband__detail">{notCompleteDetail(counts)}</p>
        </div>
        <div className="statband__cell">
          <p className="pp-label">READY</p>
          <p className="statband__n">{counts.ready}</p>
          <p className="statband__detail">ready for the stand</p>
        </div>
        <div className="statband__cell">
          <p className="pp-label">NOT STARTED</p>
          <p className="statband__n">{counts.notStarted}</p>
          <p className="statband__detail">Roadie will get to them</p>
        </div>
        {stat && (
          <StatCell
            stat={stat}
            which={`${(statOffset % stats.length) + 1} of ${stats.length}`}
            onAdvance={() => setStatOffset((i) => i + 1)}
          />
        )}
      </section>

      <div className="filterbar">
        {filterChips(counts).map(({ value, label, count }) => (
          <button
            key={value}
            type="button"
            className="filterbar__chip"
            aria-pressed={filter === value}
            onClick={() => set("filter", value === "all" ? null : value)}
          >
            {count === null ? label : `${label} · ${count}`}
          </button>
        ))}
        <div className="filterbar__tools">
          <input
            type="search"
            className="filterbar__search"
            placeholder={`Search ${counts.total} records`}
            aria-label="Search your collection by title or artist"
            value={query}
            onChange={(e) => set("q", e.target.value)}
          />
          <button
            type="button"
            className="filterbar__tool"
            onClick={() => setSeed(Math.random())}
          >
            SHUFFLED ↻
          </button>
          <button
            type="button"
            className="filterbar__tool"
            onClick={() => set("density", String((density + 1) % 3))}
          >
            {densityLabel(density)}
          </button>
        </div>
      </div>

      {/* Three different empties, because "try a different name" is useless advice when you haven't
          typed one — an empty NEEDS CARD means you have cleared it, not that you mistyped. */}
      {tiles.length === 0 && (
        <div className="pp-empty">
          <p className="pp-empty__title">
            {counts.total === 0
              ? "Your collection is empty"
              : query
                ? "Nothing matches that"
                : "Nothing here right now"}
          </p>
          <p>
            {counts.total === 0 ? (
              <Link to="/add">Add your first record</Link>
            ) : query ? (
              "Try a different name, or clear the search."
            ) : (
              "No record is waiting on this — try another chip."
            )}
          </p>
        </div>
      )}

      {tiles.length > 0 &&
        !stuckOnly &&
        (grouped ? (
          <div>
            {groupByNeed(tiles).map((group) => (
              <section key={group.need}>
                <h2 className="group__head">
                  <span className="pp-label pp-label--accent">
                    {group.label}
                  </span>
                  <span className="group__count">· {group.tiles.length}</span>
                </h2>
                <div className="grid" style={{ gridTemplateColumns: columns }}>
                  {group.tiles.map((t) => (
                    <RecordTile key={t.album.curatorId} tile={t} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div
            className="grid grid--fill"
            style={{ gridTemplateColumns: columns }}
          >
            {tiles.map((t) => (
              <RecordTile key={t.album.curatorId} tile={t} />
            ))}
            <AddTile />
          </div>
        ))}

      {/* Stuck keeps its own heading wherever it appears: it isn't a missing asset, it's a failure,
          and it reads as a sentence with a way out rather than as an error code. */}
      {stuckRow.map(({ album, state }, i) => (
        <div className="stuck" key={album.curatorId}>
          <span className="pp-label pp-label--accent">
            {i === 0 ? `STUCK · ${stuckRow.length}` : ""}
          </span>
          <span className="stuck__mark" aria-hidden="true">
            ?
          </span>
          <div className="stuck__body">
            <p className="stuck__title">{album.title || "Untitled"}</p>
            <p className="stuck__why">
              {state.kind === "stuck" ? state.sentence : ""}
              {retryProblem?.id === album.curatorId
                ? ` — ${retryProblem.why}`
                : ""}
            </p>
          </div>
          {/* The two answer different failures, so both are here (roadie-spec §8). A record that
              failed on a bad minute wants the button; one that will never resolve upstream wants
              the page, to be handed the artifact by hand. There is no re-poll to write: the
              collection polls every 3s, so the row redraws itself once Roadie picks the record up. */}
          <AsyncButton
            className="pp-action"
            onClick={() => retry(album.curatorId)}
            pendingLabel="ASKING…"
            title="Hand it back to Roadie and let it try the whole record again"
          >
            TRY AGAIN
          </AsyncButton>
          <Link to={`/albums/${album.curatorId}`} className="pp-btn">
            FIX IT
          </Link>
        </div>
      ))}

      <RoadieLog status={status} />
    </main>
  );
}
