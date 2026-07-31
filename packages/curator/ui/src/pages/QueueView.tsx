import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  type QueueEntry,
  type QueueGroups,
  type RoadieState,
} from "../api";
import { QUEUE_SECTIONS, NEXT_ACTION, relativeTime } from "../format";
import { usePoll } from "../hooks";
import { queueKeyAction } from "../queueKeys";
import { AlbumThumb, Spinner } from "../components/common";

/**
 * Write the awaiting-tag-write list onto a USB-attached Flipper (issue #68), so the on-device app
 * lists the real albums instead of you downloading a CSV and dragging it across.
 *
 * Outcome is stated in words ("Sent…" / "Failed:") rather than signalled by colour alone — this is
 * the only confirmation that the file actually reached the SD card. The failure text comes from the
 * server verbatim, because the two real failures ("no Flipper found", "port is busy") are both
 * things only the person at the desk can fix.
 */
function PushToFlipper() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const push = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.pushTagListToFlipper();
      setResult({
        ok: true,
        text: `Sent ${r.albums} album${r.albums === 1 ? "" : "s"} (${r.bytes} bytes) to ${r.port}.`,
      });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="queue-section__aside">
      <button className="btn btn--sm" onClick={push} disabled={busy}>
        {busy ? "Sending to Flipper…" : "Send list to Flipper"}
      </button>
      {result && (
        <p className={result.ok ? "muted" : "row__error"}>
          {result.ok ? "Done. " : "Failed: "}
          {result.text}
        </p>
      )}
    </div>
  );
}

/** One album row: thumbnail, title/artist, how long it's waited, and its next-action link. */
function Row({
  entry,
  action,
  selected = false,
}: {
  entry: QueueEntry;
  action?: string;
  selected?: boolean;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    // Optional-call the method too, not just the ref: scrolling the selection into view is a nicety,
    // and an environment without it (jsdom, older embedders) must not take the whole queue down.
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <Link
      ref={ref}
      to={`/albums/${entry.curatorId}`}
      className={`row ${selected ? "row--selected" : ""}`}
      aria-current={selected ? "true" : undefined}
    >
      <AlbumThumb
        curatorId={entry.curatorId}
        title={entry.title || "?"}
        version={entry.artwork}
        state={entry.state}
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
  selectedId,
  extra,
}: {
  label: string;
  entries: QueueEntry[];
  action?: string;
  /** curatorId of the keyboard-selected row, if it lives in this section. */
  selectedId?: string | null;
  /** Section-level control, rendered under the heading. Only shown when the section has rows. */
  extra?: ReactNode;
}) {
  if (!entries.length) return null;
  return (
    <section className="queue-section">
      <h2>
        {label} <span className="count">{entries.length}</span>
      </h2>
      {extra}
      {entries.map((e) => (
        <Row
          key={e.curatorId}
          entry={e}
          action={action}
          selected={e.curatorId === selectedId}
        />
      ))}
    </section>
  );
}

export function QueueView() {
  const { data, error, loading } = usePoll<QueueGroups>(api.queue, 2000);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Flattened in the order the page reads, so j/k walks it the way your eye does.
  const ordered = useMemo<QueueEntry[]>(() => {
    if (!filtered) return [];
    return [
      ...QUEUE_SECTIONS.flatMap((s) => filtered[s.bucket]),
      ...filtered.processing,
      ...filtered.errored,
      ...filtered.needs_manual,
      ...filtered.done_recently,
    ];
  }, [filtered]);
  const selected = ordered.length
    ? (ordered[Math.min(cursor, ordered.length - 1)] ?? null)
    : null;

  // Queue keyboard path (curator-ui-ux §9.1). Every one of these is also a click.
  //
  // The rows and cursor are read through refs, not the effect's closure (issue #119). React commits
  // rows to the DOM before it flushes passive effects, so a listener that captured the row list was
  // stale in exactly the moment the queue first appears: `j` clamped against an empty list and
  // `Enter` found no selection, and the keystroke was discarded with no feedback. Refs are current
  // at commit time, so the handler always decides on what is actually on screen — and the listener
  // subscribes once instead of re-subscribing on every poll.
  const rowsRef = useRef(ordered);
  rowsRef.current = ordered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const action = queueKeyAction(e.key, {
        rows: rowsRef.current,
        cursor: cursorRef.current,
        target: t,
        modifier: e.metaKey || e.ctrlKey || e.altKey,
      });
      if (!action) return;
      if (action.type === "blurTarget") {
        t?.blur();
        return;
      }
      e.preventDefault();
      if (action.type === "move") setCursor(action.cursor);
      else if (action.type === "open") navigate(`/albums/${action.curatorId}`);
      else searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

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
          ref={searchRef}
          className="search"
          placeholder="Search title or artist… ( / )"
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
          selectedId={selected?.curatorId}
          extra={
            s.bucket === "awaiting_tag_write" ? <PushToFlipper /> : undefined
          }
        />
      ))}

      {filtered.processing.length > 0 && (
        <>
          <h3 className="group-head">Roadie is on it</h3>
          <Section
            label="Processing"
            entries={filtered.processing}
            selectedId={selected?.curatorId}
          />
        </>
      )}

      {(filtered.errored.length > 0 || filtered.needs_manual.length > 0) && (
        <>
          <h3 className="group-head">Needs your attention</h3>
          <Section
            label="Errored"
            entries={filtered.errored}
            action="Retry"
            selectedId={selected?.curatorId}
          />
          <Section
            label="Needs manual"
            entries={filtered.needs_manual}
            action="Resolve"
            selectedId={selected?.curatorId}
          />
        </>
      )}

      {filtered.done_recently.length > 0 && (
        <>
          <h3 className="group-head">Done</h3>
          <Section
            label="Verified"
            entries={filtered.done_recently}
            selectedId={selected?.curatorId}
          />
        </>
      )}
    </div>
  );
}
