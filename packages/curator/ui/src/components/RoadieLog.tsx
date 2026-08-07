import { useState } from "react";
import { logTime, useRoadieLog, type LogLine } from "../roadieLog";

/**
 * Roadie's log — a footer strip on the collection, expanding into a panel (ADR 0052).
 *
 * It replaces the app-wide `RoadieStrip`, which showed `working on 2k7bxq9m (Generating palette)`
 * plus a pause button. Both are gone: the id and the state name are exactly what the overhaul
 * forbids showing, and pause was a control nobody needed to reach from every screen.
 *
 * Session-only. The panel says so, because "where did my failure go?" has a real answer — the
 * collection's Stuck group, which is durable.
 */

const Line = ({ line }: { line: LogLine }) => (
  <>
    {line.before}
    <b>{line.album}</b>
    {line.after}
  </>
);

export function RoadieLog() {
  const lines = useRoadieLog();
  const [open, setOpen] = useState(false);
  const latest = lines[0];

  return (
    <>
      <div className="roadielog">
        <p className="roadielog__badge">
          <span
            className="pp-dot pp-dot--sm pp-dot--pulse"
            aria-hidden="true"
          />
          ROADIE&apos;S LOG
        </p>
        <p className="roadielog__latest">
          {latest ? (
            <>
              <span className="roadielog__time">{logTime(latest.at)}</span>
              <span className="roadielog__line">
                <Line line={latest} />
              </span>
            </>
          ) : (
            <span className="roadielog__line">
              Nothing yet this session — Roadie will say so here.
            </span>
          )}
        </p>
        <button
          type="button"
          className="roadielog__toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "HIDE THE LOG" : "THE WHOLE LOG"}
        </button>
      </div>

      {open && (
        <div className="roadielog__panel">
          <p className="roadielog__panel-head">
            <span className="pp-label pp-label--accent">ROADIE&apos;S LOG</span>
            <span>this session, newest first</span>
          </p>
          {lines.length === 0 && (
            <p className="roadielog__row">
              Roadie hasn&apos;t done anything since Curator started.
            </p>
          )}
          {lines.map((line) => (
            <p
              key={line.id}
              className={`roadielog__row ${line.failed ? "roadielog__row--failed" : ""}`}
            >
              <span className="roadielog__time">{logTime(line.at)}</span>
              <span>
                <Line line={line} />
              </span>
            </p>
          ))}
          <p className="roadielog__foot">Cleared when Curator restarts.</p>
        </div>
      )}
    </>
  );
}
