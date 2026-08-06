import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { artworkUrl, type RoadieState } from "../api";
import { isProcessing } from "../format";
import { usePending } from "../hooks";

const initialsOf = (title: string): string =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

// The artwork endpoint 404s until Roadie downloads the cover, so a freshly-added album renders the
// initials placeholder. Detail/queue pages poll and re-render, but the <img src> is a static URL and
// the `failed` latch never resets — so the art never appears until the component remounts (issue #25).
// A `version` token that changes when the art lands (contentHash on detail, the artwork path on the
// queue) both cache-busts the URL and clears the latch, letting the cover recover in place.
export const artworkSrc = (
  curatorId: string,
  version?: string | null,
): string =>
  version
    ? `${artworkUrl(curatorId)}?v=${encodeURIComponent(version)}`
    : artworkUrl(curatorId);

type ArtStatus = "pending" | "loading" | "ready" | "absent";

/**
 * Which of the three artwork affordances to show (issue #134).
 *
 * The pre-arrival window used to look identical to genuine failure: the endpoint 404s until Roadie
 * writes the file, so the component mounted an <img> that was *known* to fail, the browser painted
 * its broken-image glyph, and only then did onError swap in the monogram. Two different "broken"
 * pictures for art that was simply still downloading.
 *
 *  - `pending` — Roadie is still working. Don't request at all; show a skeleton.
 *  - `loading` — request in flight. Keep the <img> unpainted so the glyph never lands.
 *  - `ready`   — the cover.
 *  - `absent`  — a real 404 on an album Roadie has finished with. The monogram, as before.
 */
function useArtStatus(
  version: string | null | undefined,
  state: RoadieState | undefined,
): [ArtStatus, { onLoad: () => void; onError: () => void }] {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // A new version means the art may now exist — retry the request instead of staying latched.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [version]);

  const status: ArtStatus =
    state !== undefined && isProcessing(state)
      ? "pending"
      : failed
        ? "absent"
        : loaded
          ? "ready"
          : "loading";
  return [
    status,
    { onLoad: () => setLoaded(true), onError: () => setFailed(true) },
  ];
}

/**
 * Cover thumbnail. Shows a skeleton while the art is still on its way, the album's initials when
 * there genuinely is none, and never the browser's broken-image glyph.
 *
 * Pass `state` wherever it's available: without it the component can't tell "downloading" from
 * "unavailable" and falls back to the monogram, which is the pre-#134 behaviour.
 *
 * The skeleton is marked `aria-hidden`, not `aria-busy` like AsyncButton: the cover is decorative
 * (`alt=""`) and the album's title sits next to it as real text, so there is nothing here for a
 * screen reader to wait on. `aria-busy` under `aria-hidden` would be inert anyway. `data-art` is
 * the test hook, deliberately not an ARIA attribute doing double duty.
 */
export function AlbumThumb({
  curatorId,
  title,
  version,
  state,
  size = 48,
}: {
  curatorId: string;
  title: string;
  /** Freshness token — changes when the art becomes available, clearing a stale 404 latch. */
  version?: string | null;
  /** Roadie's state, so a pending cover reads as pending rather than missing. */
  state?: RoadieState;
  size?: number;
}) {
  const [status, handlers] = useArtStatus(version, state);
  const box = { width: size, height: size };

  if (status === "pending") {
    return (
      <div
        className="thumb thumb--loading"
        style={box}
        data-art="loading"
        aria-hidden
      />
    );
  }
  if (status === "absent") {
    return (
      <div
        className="thumb thumb--placeholder"
        style={{ ...box, fontSize: size * 0.4 }}
        aria-hidden
      >
        {initialsOf(title)}
      </div>
    );
  }
  return (
    <>
      {status === "loading" && (
        <div
          className="thumb thumb--loading"
          style={box}
          data-art="loading"
          aria-hidden
        />
      )}
      {/* display:none still fetches and still fires onLoad/onError — it just never paints. */}
      <img
        className="thumb"
        style={{ ...box, display: status === "ready" ? undefined : "none" }}
        src={artworkSrc(curatorId, version)}
        alt=""
        {...handlers}
      />
    </>
  );
}

/** Full-width cover for the detail view — same three states, fills its container square. */
export function Cover({
  curatorId,
  title,
  version,
  state,
}: {
  curatorId: string;
  title: string;
  /** Freshness token — changes when the art becomes available, clearing a stale 404 latch. */
  version?: string | null;
  /** Roadie's state, so a pending cover reads as pending rather than missing. */
  state?: RoadieState;
}) {
  const [status, handlers] = useArtStatus(version, state);

  if (status === "pending") {
    return (
      <div
        className="detail__art detail__art--loading"
        data-art="loading"
        aria-hidden
      />
    );
  }
  if (status === "absent") {
    return (
      <div className="detail__art detail__art--placeholder" aria-hidden>
        {initialsOf(title)}
      </div>
    );
  }
  return (
    <>
      {status === "loading" && (
        <div
          className="detail__art detail__art--loading"
          data-art="loading"
          aria-hidden
        />
      )}
      <img
        className="detail__art"
        style={{ display: status === "ready" ? undefined : "none" }}
        src={artworkSrc(curatorId, version)}
        alt=""
        {...handlers}
      />
    </>
  );
}

// `StateBadge` lived here until 2026-08-05 (ADR 0052): a pill reading "Awaiting tag write" beside
// every row. It went with the queue — the overhaul does not name a machine state at the user, so a
// component whose entire job was rendering one had nothing left to do. What a record still needs is
// `needs.ts`, and the collection and the record page each draw it their own way.

/**
 * Open the OS file chooser and hand back what was picked.
 *
 * A detached input rather than a hidden one in the tree: nothing here needs to be tabbed to — the
 * visible button is the control, and it is a real `<button>`. Shared by the visualizer and card
 * panels, which differ only in what they accept.
 */
export function pickFile(accept: string, onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  };
  input.click();
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

type AsyncButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> & {
  /** The async action; the button shows a spinner + disables itself until it settles. */
  onClick: () => unknown;
  /** Label shown (with the spinner) while in flight. Defaults to the normal children. */
  pendingLabel?: ReactNode;
  children: ReactNode;
};

/**
 * A button that owns its own in-flight state (issue #62): while its onClick promise is pending it
 * disables itself (blocking double-submits), shows a spinner, and can swap in a "…ing" label. Drop
 * it in for the slow, generative actions — regenerate/splice/generate — and any other run-routed
 * action, so each control gives its own feedback instead of relying on one page-level boolean.
 */
export function AsyncButton({
  onClick,
  pendingLabel,
  children,
  disabled,
  ...rest
}: AsyncButtonProps) {
  const [pending, wrap] = usePending();
  return (
    <button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      onClick={() => {
        // Errors are the caller's job (the run helper surfaces them); swallow here only so a
        // rejected action can't raise an unhandled rejection. The finally in wrap still clears pending.
        if (!pending) void wrap(onClick).catch(() => {});
      }}
    >
      {pending ? (
        <>
          <Spinner /> {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
