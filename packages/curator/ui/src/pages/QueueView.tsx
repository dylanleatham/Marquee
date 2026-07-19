import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type QueueEntry,
  type QueueGroups,
  type RoadieState,
} from "../api";
import { QUEUE_SECTIONS, NEXT_ACTION, relativeTime } from "../format";
import { usePoll } from "../hooks";
import { AlbumThumb, Spinner } from "../components/common";

/** One album row: thumbnail, title/artist, how long it's waited, and its next-action link. */
function Row({ entry, action }: { entry: QueueEntry; action?: string }) {
  return (
    <Link to={`/albums/${entry.curatorId}`} className="row">
      <AlbumThumb
        curatorId={entry.curatorId}
        title={entry.title || "?"}
        version={entry.artwork}
      />
      <div className="row__main">
        <div className="row__title">{entry.title || <em>fetching…</em>}</div>
        <div className="row__sub">{entry.artist}</div>
      </div>
      {entry.lastError && (
        <div className="row__error" title={entry.lastError.message}>
          {entry.lastError.reason ?? entry.lastError.message}
        </div>
      )}
      <div className="row__time">{relativeTime(entry.enteredStateAt)}</div>
      {action && <span className="row__action">{action} →</span>}
    </Link>
  );
}

function Section({
  label,
  entries,
  action,
}: {
  label: string;
  entries: QueueEntry[];
  action?: string;
}) {
  if (!entries.length) return null;
  return (
    <section className="queue-section">
      <h2>
        {label} <span className="count">{entries.length}</span>
      </h2>
      {entries.map((e) => (
        <Row key={e.curatorId} entry={e} action={action} />
      ))}
    </section>
  );
}

export function QueueView() {
  const { data, error, loading } = usePoll<QueueGroups>(api.queue, 2000);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = query.trim().toLowerCase();
    if (!q) return data;
    const match = (e: QueueEntry) =>
      e.title.toLowerCase().includes(q) || e.artist.toLowerCase().includes(q);
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v.filter(match)]),
    ) as QueueGroups;
  }, [data, query]);

  if (error)
    return (
      <div className="page">
        <div className="banner banner--error">
          Couldn't load the queue: {error}
        </div>
      </div>
    );
  if (!filtered)
    return (
      <div className="page">
        <Spinner /> Loading queue…
      </div>
    );

  const needsYouTotal = QUEUE_SECTIONS.reduce(
    (n, s) => n + filtered[s.bucket].length,
    0,
  );
  const nothing =
    Object.values(filtered).every((v) => v.length === 0) && !loading;

  return (
    <div className="page">
      <div className="page__head">
        <h1>Queue</h1>
        <input
          className="search"
          placeholder="Search title or artist…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Link to="/add" className="btn btn--primary">
          + Add album
        </Link>
      </div>

      {nothing && (
        <div className="empty">
          Nothing here yet. <Link to="/add">Add an album</Link> and Roadie will
          get to work.
        </div>
      )}

      <h3 className="group-head">
        Needs you right now{needsYouTotal ? ` · ${needsYouTotal}` : ""}
      </h3>
      {QUEUE_SECTIONS.map((s) => (
        <Section
          key={s.bucket}
          label={s.label}
          entries={filtered[s.bucket]}
          action={NEXT_ACTION[s.bucket as RoadieState]}
        />
      ))}

      {filtered.processing.length > 0 && (
        <>
          <h3 className="group-head">Roadie is on it</h3>
          <Section label="Processing" entries={filtered.processing} />
        </>
      )}

      {(filtered.errored.length > 0 || filtered.needs_manual.length > 0) && (
        <>
          <h3 className="group-head">Needs your attention</h3>
          <Section label="Errored" entries={filtered.errored} action="Retry" />
          <Section
            label="Needs manual"
            entries={filtered.needs_manual}
            action="Resolve"
          />
        </>
      )}

      {filtered.done_recently.length > 0 && (
        <>
          <h3 className="group-head">Done</h3>
          <Section label="Verified" entries={filtered.done_recently} />
        </>
      )}
    </div>
  );
}
