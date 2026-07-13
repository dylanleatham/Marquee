import { useState } from "react";
import { artworkUrl, type RoadieState } from "../api";
import { STATE_LABEL, isProcessing } from "../format";

const initialsOf = (title: string): string =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Cover thumbnail that degrades to the album's initials while art is missing (404) or absent. */
export function AlbumThumb({
  curatorId,
  title,
  size = 48,
}: {
  curatorId: string;
  title: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
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
      src={artworkUrl(curatorId)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

/** Full-width cover for the detail view — same art/initials fallback, fills its container square. */
export function Cover({
  curatorId,
  title,
}: {
  curatorId: string;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
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
      src={artworkUrl(curatorId)}
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
