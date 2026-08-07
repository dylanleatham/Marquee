import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SpotifyAlbumMeta } from "../api";
import { errorMessage } from "../errors";

/**
 * Add a record (ADR 0052).
 *
 * Three changes from the old Add screen:
 *
 * - **Adding never navigates away.** The old screen jumped to the album you just added, which is
 *   exactly wrong for the actual task: you sat down to add *several*. A running line at the bottom
 *   says what has landed, and the search box keeps its query.
 * - **"Paste a link" is gone.** Its whole audience was "I have a list of Spotify URIs", which is a
 *   thing you have because the old Discogs flow made you collect them by hand. Discogs syncs now.
 * - **Discogs is a link out, not a tab.** It is a standing relationship with its own screen
 *   (ADR 0051), not one of the ways to pick a record.
 */

type Tab = "search" | "manual";

/** One added record, for the running line. Kept in order so the newest reads last. */
interface Added {
  curatorId: string;
  title: string;
  /**
   * What was added, not what it is called. Records share titles — a reissue, a live album, an
   * unrelated record of the same name — and keying this on the title marked every namesake ADDED and
   * disabled it, so the ones you actually wanted could not be added at all.
   */
  spotifyUri: string;
}

function Results({
  results,
  added,
  onAdd,
  busy,
}: {
  results: SpotifyAlbumMeta[];
  added: Added[];
  onAdd: (a: SpotifyAlbumMeta) => void;
  busy: string | null;
}) {
  const isAdded = (a: SpotifyAlbumMeta) =>
    added.some((x) => x.spotifyUri === a.spotifyUri);
  return (
    <div className="addgrid">
      {results.map((a) => (
        <button
          key={a.spotifyId}
          type="button"
          className="addgrid__cell"
          disabled={busy === a.spotifyUri || isAdded(a)}
          onClick={() => onAdd(a)}
        >
          {a.artUrl ? (
            <img
              className="addgrid__art"
              src={a.artUrl}
              alt=""
              loading="lazy"
            />
          ) : (
            <span
              className="addgrid__art addgrid__art--none"
              aria-hidden="true"
            />
          )}
          <span className="addgrid__title">{a.name}</span>
          <span className="addgrid__byline">
            {a.year ? `${a.artist} · ${a.year}` : a.artist}
          </span>
          {/* State in words: the tile stops being pressable, and says why. */}
          {isAdded(a) && <span className="addgrid__state">ADDED</span>}
          {busy === a.spotifyUri && (
            <span className="addgrid__state">ADDING…</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function AddRecord({
  initialTab = "search",
}: { initialTab?: Tab } = {}) {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("how") === "manual" ? "manual" : initialTab) as Tab;
  // `?q=` is how the Discogs screen hands over an unmatched pressing (§8.8): you clicked SEARCH BY
  // HAND on a title, so that title is what the box should already hold — and the debounce below
  // means the search runs without a keystroke. Read once, as the initial value: retyping must not be
  // fought by the URL, and the URL is not updated as you type.
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [results, setResults] = useState<SpotifyAlbumMeta[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  // Debounced search. The sequence number drops a slow response that a newer query has overtaken —
  // otherwise typing fast leaves you looking at results for a prefix you no longer see.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSpotify(term)
        .then((r) => {
          if (mine !== seq.current) return;
          setResults(r.results);
          setError(null);
        })
        .catch((err: unknown) => {
          if (mine !== seq.current) return;
          setError(errorMessage(err));
        })
        .finally(() => mine === seq.current && setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const add = async (a: SpotifyAlbumMeta) => {
    setBusy(a.spotifyUri);
    setError(null);
    try {
      const { curatorId } = await api.addSpotify(a.spotifyUri);
      setAdded((prev) => [
        ...prev,
        { curatorId, title: a.name, spotifyUri: a.spotifyUri },
      ]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const addManual = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    // The input, not the FormData entry: `required` on a file input is enforced by the browser only
    // on an implicit submit, so this is the check that actually runs, and reading the element says
    // plainly what is being asked.
    const sleeve = (form.elements.namedItem("artwork") as HTMLInputElement)
      ?.files?.[0];
    if (!sleeve) {
      setError(
        "A record typed in by hand needs a cover to pull its lights from.",
      );
      return;
    }
    setBusy("manual");
    setError(null);
    try {
      const { curatorId } = await api.addManual(data);
      setAdded((prev) => [
        ...prev,
        {
          curatorId,
          title: String(data.get("name") ?? "Untitled"),
          // A hand-typed record has no Spotify identity, and the curatorId is unique, so it can
          // never collide with a search result's uri.
          spotifyUri: `curator:${curatorId}`,
        },
      ]);
      form.reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="pp-title screen__title">Add a record</h1>
      </header>

      <nav className="screen__tabs" aria-label="How to add">
        <button
          type="button"
          className="screen__tab"
          aria-current={tab === "search" ? "page" : undefined}
          onClick={() => setParams({}, { replace: true })}
        >
          SEARCH
        </button>
        <button
          type="button"
          className="screen__tab"
          aria-current={tab === "manual" ? "page" : undefined}
          onClick={() => setParams({ how: "manual" }, { replace: true })}
        >
          TYPE IT IN
        </button>
        {/* A link out, not a tab: Discogs is a standing collection, not a way to pick one record. */}
        <Link className="screen__tab screen__tab--out" to="/discogs">
          SYNC DISCOGS ›
        </Link>
      </nav>

      <div className="screen__body">
        {tab === "search" ? (
          <>
            <input
              type="search"
              className="addsearch"
              aria-label="Search Spotify for a record"
              placeholder="a record you own"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
            {error && <p className="pp-error">{error}</p>}
            {q.trim() && !searching && results.length === 0 && !error && (
              <p className="pp-prose">
                Nothing on Spotify by that name. Try fewer words, or type it in
                by hand.
              </p>
            )}
            <Results results={results} added={added} onAdd={add} busy={busy} />
          </>
        ) : (
          <form className="typein" onSubmit={addManual}>
            <label className="typein__field">
              <span className="pp-label">TITLE</span>
              <input name="name" required />
            </label>
            <label className="typein__field">
              <span className="pp-label">ARTIST</span>
              <input name="artist" required />
            </label>
            <label className="typein__field">
              <span className="pp-label">YEAR</span>
              <input name="year" type="number" min="1900" max="2100" />
            </label>
            <label className="typein__field">
              <span className="pp-label">THE SLEEVE</span>
              <input name="artwork" type="file" accept="image/*" required />
            </label>
            <p className="typein__note">
              The cover is where the lights come from, so a record typed in by
              hand needs one.
            </p>
            {error && <p className="pp-error">{error}</p>}
            <button className="pp-btn" disabled={busy === "manual"}>
              {busy === "manual" ? "ADDING…" : "ADD IT"}
            </button>
          </form>
        )}

        {/* The reason adding doesn't navigate: you came here to add several. */}
        {added.length > 0 && (
          <p className="addedline">
            added just now:{" "}
            {added.map((a, i) => (
              <span key={a.curatorId}>
                {i > 0 && " · "}
                <Link to={`/albums/${a.curatorId}`}>{a.title}</Link>
              </span>
            ))}{" "}
            — keep going, they&apos;ll appear in your collection
          </p>
        )}
      </div>
    </main>
  );
}
