import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  type DiscogsCollectionItem,
  type SpotifyAlbumMeta,
} from "../api";
import { Spinner } from "../components/common";

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

/** Paste one `spotify:album:…` URI per line; each is added and enqueued separately. */
function PasteUri({ onAdded }: { onAdded: (ids: string[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const submit = async () => {
    const uris = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!uris.length) return;
    setBusy(true);
    setErrors([]);
    const ids: string[] = [];
    const errs: string[] = [];
    for (const uri of uris) {
      try {
        const { curatorId } = await api.addSpotify(uri);
        ids.push(curatorId);
      } catch (err) {
        errs.push(
          `${uri}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    setBusy(false);
    setErrors(errs);
    if (ids.length) onAdded(ids);
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
      {errors.map((e, i) => (
        <div key={i} className="banner banner--error">
          {e}
        </div>
      ))}
      <button className="btn btn--primary" onClick={submit} disabled={busy}>
        {busy ? "Adding…" : "Add all"}
      </button>
    </div>
  );
}

/**
 * Browse your Discogs collection and send albums to Roadie (issue #24 / ADR 0016). Paginated: "Load
 * more" fetches the next page. Each row's "Send to Roadie" adds it (source = "discogs"); Roadie
 * fetches the release detail + cover art off the request path. Rows already added are marked.
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
          {state === "loading" ? "Loading…" : `Load more (page ${page + 1} of ${pages})`}
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

export function AddAlbum() {
  const [mode, setMode] = useState<Mode>("search");
  const navigate = useNavigate();
  const goToAlbum = (id: string) => navigate(`/albums/${id}`);
  const goToQueue = () => navigate("/");

  return (
    <div className="page">
      <div className="page__head">
        <button className="btn btn--ghost" onClick={goToQueue}>
          ← Queue
        </button>
        <h1>Add album</h1>
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
