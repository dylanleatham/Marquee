import { NavLink, Link } from "react-router-dom";
import type { AlbumSummary } from "../api";
import { collectionCounts } from "../collection";
// Inlined rather than linked as an `<img>`: the mark is drawn in `currentColor`, and an SVG loaded
// through `<img>` is a separate document that cannot see this one's colour. Inline, it is ink here
// and would reverse to paper anywhere the brand block does. The file is a build-time repo asset —
// there is no user input on this path (ADR 0091).
import markSvg from "../assets/marquee-mark.svg?raw";

/**
 * The persistent masthead (ADR 0052): four regions in one flex row, each divided by a hairline —
 * brand, nav, progress, Roadie.
 *
 * It replaces a header that carried a "needs you" count, a Jump… button and two links. The count is
 * now a progress bar (how far the whole collection is, not how much is nagging you), and the jump
 * button went with the command palette.
 */

const NAV = [
  { to: "/", label: "COLLECTION", end: true },
  { to: "/add", label: "ADD A RECORD", end: false },
  { to: "/discogs", label: "DISCOGS", end: false },
  { to: "/system", label: "SYSTEM", end: false },
  { to: "/settings", label: "SETTINGS", end: false },
];

export function Masthead({
  albums,
  roadieWorking,
}: {
  /** Null while the first fetch is in flight — the progress region simply holds its space. */
  albums: AlbumSummary[] | null;
  roadieWorking: boolean;
}) {
  const counts = albums ? collectionCounts(albums) : null;
  const pct =
    counts && counts.total
      ? Math.round((counts.ready / counts.total) * 100)
      : 0;

  return (
    <header className="masthead">
      <Link to="/" className="masthead__brand">
        {/* The Marquee mark. It is decoration beside a wordmark that already says "Curator" and
            "MARQUEE COLLECTION", so it is hidden from assistive tech rather than described twice. */}
        <span
          className="masthead__mark"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: markSvg }}
        />
        <span>
          <span className="masthead__wordmark">Curator</span>
          <span className="masthead__sub">MARQUEE COLLECTION</span>
        </span>
      </Link>

      <nav className="masthead__nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="masthead__nav-item"
            // NavLink sets aria-current="page" itself; the active style keys off that rather than a
            // second class, so the visual state and the announced state cannot drift apart.
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="masthead__right">
        {counts && (
          <>
            <p className="masthead__progress">
              <span className="masthead__progress-n">{counts.ready}</span>
              <span className="masthead__progress-of">
                OF {counts.total} READY
              </span>
            </p>
            {/* The bar repeats what the words already said — it is the glanceable channel, never
                the only one (curator-ui-ux §3.4). */}
            <div className="masthead__bar" aria-hidden="true">
              <div
                className="masthead__bar-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        )}
        {roadieWorking && (
          <p className="masthead__roadie">
            <span className="pp-dot pp-dot--pulse" aria-hidden="true" />
            ROADIE WORKING
          </p>
        )}
      </div>
    </header>
  );
}
