// ⌘K — jump to an album, or run a command (curator-ui-ux §9.1, ADR 0043).
//
// The spec asks for a fuzzy jump over title/artist. The overlay that needs to exist for that — an
// input, a ranked list, keyboard selection, dismissal — is the same surface a command list wants, so
// it carries both: albums first, then a short list of the destinations that otherwise cost a trip to
// the header. Ranking lives in `commandPalette.ts` so it is testable without a DOM.
//
// Everything here is also reachable by mouse; the palette is an accelerator over the header links
// and the queue, never the only way to any of it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type AlbumSummary } from "../api";
import { STATE_LABEL } from "../format";
import { clampCursor, rankPalette, type PaletteItem } from "../commandPalette";

/** A ranked row plus what choosing it does. `run` is deliberately off the ranked type. */
interface PaletteRow extends PaletteItem {
  run: () => void;
  /** Right-aligned context: the album's state, or the command's own keyboard shortcut. */
  hint?: string;
}

/**
 * The commands the palette offers. Deliberately the *navigational* ones: every entry lands you
 * somewhere and changes nothing on its own.
 *
 * Arming the room is **not** here, and that is the point (ADR 0028 / 0043): it drives real lights and
 * real speakers in a room that may have people in it, and its switch lives in the status bar
 * precisely so its state is continuously visible. A palette entry would let it be flipped by a
 * half-remembered keystroke and then forgotten.
 */
function commandRows(go: (to: string) => void): PaletteRow[] {
  return [
    {
      id: "cmd:queue",
      group: "command",
      label: "Queue",
      sublabel: "Everything waiting on you",
      keywords: ["home", "albums", "list"],
      run: () => go("/"),
    },
    {
      id: "cmd:add",
      group: "command",
      label: "Add album",
      sublabel: "Search Spotify or Discogs",
      keywords: ["new", "import"],
      hint: "n",
      run: () => go("/add"),
    },
    {
      id: "cmd:system",
      group: "command",
      label: "System status",
      sublabel: "Services, what's playing, and which albums the runtime has",
      keywords: ["health", "runtime", "stylus", "diagnose", "sync", "drift"],
      run: () => go("/system"),
    },
    {
      id: "cmd:settings",
      group: "command",
      label: "Settings",
      sublabel: "Services, keys, and generation opt-ins",
      keywords: ["preferences", "config", "gemini", "hue"],
      hint: "⌘,",
      run: () => go("/settings"),
    },
    {
      id: "cmd:tag-help",
      group: "command",
      label: "How do I write tags?",
      sublabel: "The NFC walkthrough",
      keywords: ["nfc", "sticker", "flipper"],
      run: () => go("/help/tags"),
    },
  ];
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetched when the palette opens rather than polled: it is a modal you hold open for a second or
  // two, and a background poll for the whole library would run all session for nothing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setLoadError(null);
    inputRef.current?.focus();
    let alive = true;
    api
      .albums()
      .then((r) => {
        if (alive) setAlbums(r.albums);
      })
      .catch((e: unknown) => {
        // The commands still work without the library — say why the albums aren't there rather
        // than showing an empty list that looks like "you have no albums".
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const rows = useMemo<PaletteRow[]>(() => {
    const go = (to: string) => {
      onClose();
      navigate(to);
    };
    const albumRows: PaletteRow[] = (albums ?? []).map((a) => ({
      id: a.curatorId,
      group: "album",
      label: a.title || a.curatorId,
      sublabel: a.artist,
      hint: STATE_LABEL[a.state],
      run: () => go(`/albums/${a.curatorId}`),
    }));
    return rankPalette(query, [...albumRows, ...commandRows(go)]);
  }, [albums, query, navigate, onClose]);

  // Clamped against the list as it is now: every keystroke re-ranks, so a cursor parked on row 5
  // must land somewhere real when the next letter cuts the list to two (issue #119's rule).
  const active = clampCursor(cursor, rows.length);
  const selected = rows[active] ?? null;

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(clampCursor(active + 1, rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(clampCursor(active - 1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selected?.run();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      // ⌘K again closes it. The global handler can't: focus is in this input, and no global
      // shortcut fires while the user is typing in a field (§9.1).
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-scrim command-palette-scrim" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to album or run a command"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={
            selected ? `command-palette-opt-${active}` : undefined
          }
          aria-label="Jump to album or run a command"
          placeholder="Jump to an album, or run a command…"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul
          className="command-palette__list"
          id="command-palette-list"
          role="listbox"
        >
          {rows.map((row, i) => (
            <li
              key={row.id}
              id={`command-palette-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`command-palette__row ${i === active ? "is-active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={row.run}
            >
              {/* The caret, not just the highlight, marks the selection: a colour-only cue is
                  unreadable without colour vision (curator-ui-ux §3.4). */}
              <span className="command-palette__caret" aria-hidden="true">
                {i === active ? "▸" : ""}
              </span>
              <span className="command-palette__label">
                {row.label}
                {row.sublabel && (
                  <span className="command-palette__sub">
                    {" "}
                    — {row.sublabel}
                  </span>
                )}
              </span>
              <span className="command-palette__hint">
                {row.hint ?? "Command"}
              </span>
            </li>
          ))}
        </ul>
        {/* A palette that shows nothing must say why: no matches, still loading, or the fetch
            failed are three different situations with three different next moves. */}
        {rows.length === 0 && (
          <p className="command-palette__empty">
            {query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : albums === null && !loadError
                ? "Loading the library…"
                : "Type to find an album by title or artist."}
          </p>
        )}
        {loadError && (
          <p className="command-palette__error">
            Couldn't load albums: {loadError}. Commands still work.
          </p>
        )}
        <div className="command-palette__foot muted">
          ↑↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
