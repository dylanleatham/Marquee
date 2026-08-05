import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { artworkUrl, type AlbumSummary } from "../api";
import {
  collectionCounts,
  densityColumns,
  densityLabel,
  groupByNeed,
  notCompleteDetail,
  stuckTiles,
  visibleTiles,
  type CollectionFilter,
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

  if (state.kind === "stuck")
    return (
      <div className={className} aria-hidden="true">
        ?
      </div>
    );
  if (album.artwork && !broken)
    return (
      <img
        className={className}
        src={artworkUrl(album.curatorId)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  return (
    <div
      className={className}
      style={{ background: hatch(album.paletteHexes) }}
      aria-hidden="true"
    />
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
}: {
  albums: AlbumSummary[] | null;
  error: string | null;
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

  const raw = params.get("filter");
  const filter: CollectionFilter =
    raw === "needs" || raw === "ready" ? raw : "all";
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
        {(
          [
            ["all", "EVERYTHING"],
            ["needs", `NOT COMPLETE · ${counts.notComplete}`],
            ["ready", `READY · ${counts.ready}`],
          ] as Array<[CollectionFilter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="filterbar__chip"
            aria-pressed={filter === value}
            onClick={() => set("filter", value === "all" ? null : value)}
          >
            {label}
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

      {tiles.length === 0 && (
        <div className="pp-empty">
          <p className="pp-empty__title">
            {counts.total === 0
              ? "Your collection is empty"
              : "Nothing matches that"}
          </p>
          <p>
            {counts.total === 0 ? (
              <Link to="/add">Add your first record</Link>
            ) : (
              "Try a different name, or clear the search."
            )}
          </p>
        </div>
      )}

      {tiles.length > 0 &&
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

      {/* Stuck sits below the groups and keeps its own heading: it isn't a missing asset, it's a
          failure, and it reads as a sentence with a way out rather than as an error code. */}
      {grouped &&
        stuck.map(({ album, state }, i) => (
          <div className="stuck" key={album.curatorId}>
            <span className="pp-label pp-label--accent">
              {i === 0 ? `STUCK · ${stuck.length}` : ""}
            </span>
            <span className="stuck__mark" aria-hidden="true">
              ?
            </span>
            <div className="stuck__body">
              <p className="stuck__title">{album.title || "Untitled"}</p>
              <p className="stuck__why">
                {state.kind === "stuck" ? state.sentence : ""}
              </p>
            </div>
            <Link to={`/albums/${album.curatorId}`} className="pp-btn">
              FIX IT
            </Link>
          </div>
        ))}

      <RoadieLog />
    </main>
  );
}
