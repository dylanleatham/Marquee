import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  type BatchAddReport,
  type BatchAddStatus,
  type DiscogsCollectionItem,
  type SpotifyAlbumMeta,
} from "../api";
import { AsyncButton, Spinner } from "../components/common";
import { startDiscogsSync, useDiscogsSyncJob } from "../discogsSyncJob";

type Mode = "search" | "uri" | "discogs" | "manual";

/** Debounced Spotify autocomplete → click a result to add it (curator-spec §10). */
function SpotifySearch({ onAdded }: { onAdded: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SpotifyAlbumMeta[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const onChange = (value: string) => {
    setQ(value);
    clearTimeout(timer.current);
    if (!value.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setState("searching");
      try {
        const { results } = await api.searchSpotify(value.trim());
        setResults(results);
        setState("idle");
      } catch (err) {
        setState("error");
        setMsg(err instanceof Error ? err.message : String(err));
      }
    }, 300); // debounce (curator-spec §12 gotcha)
  };

  const add = async (a: SpotifyAlbumMeta) => {
    try {
      const { curatorId } = await api.addSpotify(a.spotifyUri);
      onAdded(curatorId);
    } catch (err) {
      setState("error");
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        className="search search--wide"
        autoFocus
        placeholder="Search Spotify — album or artist…"
        value={q}
        onChange={(e) => onChange(e.target.value)}
      />
      {state === "searching" && (
        <p className="muted">
          <Spinner /> Searching…
        </p>
      )}
      {state === "error" && <div className="banner banner--error">{msg}</div>}
      <div className="results">
        {results.map((a) => (
          <button key={a.spotifyId} className="result" onClick={() => add(a)}>
            {a.artUrl && <img src={a.artUrl} alt="" />}
            <div>
              <div className="result__title">{a.name}</div>
              <div className="result__sub">
                {a.artist}
                {a.year ? ` · ${a.year}` : ""}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const ADD_STATUS_LABEL: Record<BatchAddStatus, string> = {
  added: "Added",
  duplicate: "Already in the collection",
  invalid: "Not a Spotify album URI",
  failed: "Failed",
};

/**
 * Paste one `spotify:album:…` URI per line. Submitted as a single batch (issue #104) so the answer is
 * a per-line report rather than N independent requests whose failures the screen can only lump
 * together: "18 added, line 7 was already 2k7bxq9m, line 12 isn't a URI" is the useful answer.
 *
 * The report stays on screen after a partial success instead of navigating away — with twenty lines
 * in flight, the outcome *is* the result, and leaving for the queue would throw it away.
 */
function PasteUri({ onAdded }: { onAdded: (ids: string[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BatchAddReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const uris = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!uris.length) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await api.addAlbumsBatch(uris);
      setReport(result);
      // Clean sweep → straight to the queue, which is what you wanted. Anything else stays put so
      // the report can be read.
      if (result.added === uris.length) onAdded(result.curatorIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <textarea
        className="textarea"
        rows={6}
        placeholder={"spotify:album:1C2h7mLntPSeVYciMRTF4a\nspotify:album:…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="banner banner--error">{error}</div>}
      {report && (
        <div className="batch-add">
          <p className="batch-add__summary">
            {report.added} added
            {report.duplicate > 0 && ` · ${report.duplicate} already added`}
            {report.invalid > 0 && ` · ${report.invalid} not a URI`}
            {report.failed > 0 && ` · ${report.failed} failed`}
          </p>
          <ul className="batch-add__rows">
            {report.items
              .filter((i) => i.status !== "added")
              .map((i) => (
                <li key={i.index} className="batch-add__row">
                  <b>Line {i.index + 1}</b>
                  <code>{i.input}</code>
                  <span>{ADD_STATUS_LABEL[i.status]}</span>
                  {i.curatorId && (
                    <Link to={`/albums/${i.curatorId}`}>{i.curatorId}</Link>
                  )}
                </li>
              ))}
          </ul>
          {report.added > 0 && (
            <button
              className="btn btn--ghost"
              onClick={() => onAdded(report.curatorIds)}
            >
              Go to queue
            </button>
          )}
        </div>
      )}
      <button className="btn btn--primary" onClick={submit} disabled={busy}>
        {busy ? "Adding…" : "Add all"}
      </button>
    </div>
  );
}

/**
 * Sweep the whole collection in one go (issue #234) — the answer to "I have 400 records and I am not
 * clicking 400 buttons".
 *
 * One button, not two: the first sync and every later refresh are the same operation, because dedupe
 * is on the Discogs release id. A separate "refresh" button would be the same request with a
 * different label, and two buttons would imply a difference that isn't there.
 *
 * Progress lives in the app-wide panel (DiscogsSyncProgress), not here, so you can start it and go
 * somewhere else — a first sync of a real collection runs for minutes.
 */
function SyncCollection() {
  const { job } = useDiscogsSyncJob();
  const running = job?.status === "running";

  return (
    <div className="discogs-sync">
      <div className="discogs-sync__text">
        <b>Sync your whole collection</b>
        <p className="muted">
          Adds every record in your Discogs collection and queues Roadie to
          fetch cover art, colours, and metadata. Run it again any time to pick
          up new records — anything already here is left alone, and no AI
          credits are spent.
        </p>
      </div>
      <AsyncButton
        className="btn btn--primary"
        onClick={startDiscogsSync}
        pendingLabel="Starting…"
        disabled={running}
      >
        {running ? "Syncing…" : "Sync collection"}
      </AsyncButton>
    </div>
  );
}

/**
 * Browse your Discogs collection and send albums to Roadie (issue #24 /
 * [ADR 0017](../../../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)).
 * Paginated: "Load more" fetches the next page. Each row's "Send to Roadie" adds it
 * (source = "discogs"); Roadie fetches the release detail + cover art off the request path. Rows
 * already added are marked.
 *
 * The per-row button is still here on purpose — sometimes you want one record, not the collection.
 * The sweep above it is for the other case.
 */
function DiscogsCollection({ onAdded }: { onAdded: (id: string) => void }) {
  const [items, setItems] = useState<DiscogsCollectionItem[]>([]);
  const [page, setPage] = useState(0); // 0 = nothing loaded yet
  const [pages, setPages] = useState(1);
  const [state, setState] = useState<
    "idle" | "loading" | "error" | "unconfigured"
  >("idle");
  const [msg, setMsg] = useState("");
  const [added, setAdded] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadPage = async (next: number) => {
    setState("loading");
    setMsg("");
    try {
      const res = await api.discogsCollection(next);
      setItems((prev) => (next === 1 ? res.items : [...prev, ...res.items]));
      setPage(res.page);
      setPages(res.pages);
      setState("idle");
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setState("unconfigured");
        return;
      }
      setState("error");
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // Load the first page on mount.
  useEffect(() => {
    void loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (item: DiscogsCollectionItem) => {
    setBusyId(item.releaseId);
    try {
      const { curatorId } = await api.addDiscogs(item);
      setAdded((prev) => ({ ...prev, [item.releaseId]: curatorId }));
      onAdded(curatorId);
    } catch (err) {
      // A duplicate (409) still "resolves" to the existing album — surface it, don't error the page.
      if (err instanceof ApiError && err.status === 409) {
        setMsg(err.message);
      } else {
        setState("error");
        setMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyId(null);
    }
  };

  if (state === "unconfigured")
    return (
      <div className="banner banner--warn">
        Discogs isn't configured. Add a personal access token in{" "}
        <a href="/settings">Settings</a> to browse your collection.
      </div>
    );

  return (
    <div>
      <SyncCollection />
      {state === "error" && <div className="banner banner--error">{msg}</div>}
      {state !== "error" && msg && (
        <div className="banner banner--warn">{msg}</div>
      )}
      {page === 0 && state === "loading" && (
        <p className="muted">
          <Spinner /> Loading your collection…
        </p>
      )}
      <div className="results">
        {items.map((a) => {
          const done = added[a.releaseId];
          return (
            <div key={a.releaseId} className="result">
              {(a.thumb || a.coverImage) && (
                <img src={a.thumb || a.coverImage} alt="" />
              )}
              <div>
                <div className="result__title">{a.title}</div>
                <div className="result__sub">
                  {a.artist}
                  {a.year ? ` · ${a.year}` : ""}
                </div>
              </div>
              {done ? (
                <span className="badge badge--done result__action">Added</span>
              ) : (
                <button
                  className="btn btn--primary result__action"
                  onClick={() => add(a)}
                  disabled={busyId === a.releaseId}
                >
                  {busyId === a.releaseId ? "Sending…" : "Send to Roadie"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {page > 0 && page < pages && (
        <button
          className="btn"
          onClick={() => loadPage(page + 1)}
          disabled={state === "loading"}
        >
          {state === "loading"
            ? "Loading…"
            : `Load more (page ${page + 1} of ${pages})`}
        </button>
      )}
    </div>
  );
}

/** Manual entry — title/artist/year/genres + a required cover upload. Source = "manual". */
function ManualEntry({ onAdded }: { onAdded: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!(form.get("artwork") as File)?.size) {
      setError("A cover image is required for manual albums.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { curatorId } = await api.addManual(form);
      onAdded(curatorId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <label>
        Title
        <input name="name" required />
      </label>
      <label>
        Artist
        <input name="artist" required />
      </label>
      <label>
        Year
        <input name="year" type="number" min="1900" max="2100" />
      </label>
      <label>
        Genres (comma-separated)
        <input name="genres" placeholder="funk, rock" />
      </label>
      <label>
        Cover image
        <input name="artwork" type="file" accept="image/*" required />
      </label>
      {error && <div className="banner banner--error">{error}</div>}
      <button className="btn btn--primary" disabled={busy}>
        {busy ? "Adding…" : "Add album"}
      </button>
    </form>
  );
}

export function AddAlbum({
  /** Which tab to open on. The masthead's DISCOGS item lands here until Discogs gets its own
   * screen (ADR 0052), so that nav item goes somewhere real rather than nowhere. */
  initialTab = "search",
}: {
  initialTab?: Mode;
} = {}) {
  const [mode, setMode] = useState<Mode>(initialTab);
  const navigate = useNavigate();
  const goToAlbum = (id: string) => navigate(`/albums/${id}`);
  const goToQueue = () => navigate("/");

  return (
    <div className="page">
      <div className="page__head">
        <button className="btn btn--ghost" onClick={goToQueue}>
          ← The collection
        </button>
        <h1>Add a record</h1>
      </div>

      <div className="tabs">
        {(["search", "uri", "discogs", "manual"] as Mode[]).map((mo) => (
          <button
            key={mo}
            className={`tab ${mode === mo ? "tab--active" : ""}`}
            onClick={() => setMode(mo)}
          >
            {mo === "search"
              ? "Spotify search"
              : mo === "uri"
                ? "Paste URI"
                : mo === "discogs"
                  ? "Discogs collection"
                  : "Manual entry"}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {mode === "search" && <SpotifySearch onAdded={goToAlbum} />}
        {mode === "uri" && <PasteUri onAdded={goToQueue} />}
        {mode === "discogs" && <DiscogsCollection onAdded={goToQueue} />}
        {mode === "manual" && <ManualEntry onAdded={goToAlbum} />}
      </div>
    </div>
  );
}
