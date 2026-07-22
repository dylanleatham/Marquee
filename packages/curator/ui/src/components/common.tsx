import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { artworkUrl, type RoadieState } from "../api";
import { STATE_LABEL, isProcessing } from "../format";
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
const artworkSrc = (curatorId: string, version?: string | null): string =>
  version
    ? `${artworkUrl(curatorId)}?v=${encodeURIComponent(version)}`
    : artworkUrl(curatorId);

/** Cover thumbnail that degrades to the album's initials while art is missing (404) or absent. */
export function AlbumThumb({
  curatorId,
  title,
  version,
  size = 48,
}: {
  curatorId: string;
  title: string;
  /** Freshness token — changes when the art becomes available, clearing a stale 404 latch. */
  version?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  // A new version means the art may now exist — retry the request instead of staying latched.
  useEffect(() => setFailed(false), [version]);
  if (failed) {
    return (
      <div
        className="thumb thumb--placeholder"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        aria-hidden
      >
        {initialsOf(title)}
      </div>
    );
  }
  return (
    <img
      className="thumb"
      style={{ width: size, height: size }}
      src={artworkSrc(curatorId, version)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

/** Full-width cover for the detail view — same art/initials fallback, fills its container square. */
export function Cover({
  curatorId,
  title,
  version,
}: {
  curatorId: string;
  title: string;
  /** Freshness token — changes when the art becomes available, clearing a stale 404 latch. */
  version?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  // A new version means the art may now exist — retry the request instead of staying latched.
  useEffect(() => setFailed(false), [version]);
  if (failed) {
    return (
      <div className="detail__art detail__art--placeholder" aria-hidden>
        {initialsOf(title)}
      </div>
    );
  }
  return (
    <img
      className="detail__art"
      src={artworkSrc(curatorId, version)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

/** State pill. Processing states pulse; terminal/error states carry a distinct color. */
export function StateBadge({ state }: { state: RoadieState }) {
  const tone = isProcessing(state)
    ? "processing"
    : state === "errored" || state === "needs_manual"
      ? "alert"
      : state === "verified"
        ? "done"
        : "waiting";
  return (
    <span
      className={`badge badge--${tone}`}
      data-processing={isProcessing(state)}
    >
      {STATE_LABEL[state]}
    </span>
  );
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
