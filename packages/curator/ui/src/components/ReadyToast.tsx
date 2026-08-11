import { useNavigate } from "react-router-dom";
import { artworkSrc } from "./common";
import type { AlbumSummary } from "../api";
import { dismissReadyToast, useReadyToast } from "../readyToast";

/**
 * "<Title> is ready" (ADR 0052) — the whole thing is one button.
 *
 * Tapping it opens the room for that record, because the only reason to look back at a record you
 * have just finished is to watch it. That also cancels the timer, so the toast can't fade out from
 * under the screen it just opened.
 *
 * The one shadow in the design lives here, and it is the reason: this is the only element that
 * floats above the paper rather than being printed on it.
 */
export function ReadyToast({ albums }: { albums: AlbumSummary[] | null }) {
  const curatorId = useReadyToast();
  const navigate = useNavigate();
  if (!curatorId) return null;

  const album = albums?.find((a) => a.curatorId === curatorId);
  // Named, or not shown. "Untitled is ready" is worse than the quiet the toast replaced.
  if (!album) return null;

  return (
    <button
      type="button"
      className="toast"
      onClick={() => {
        dismissReadyToast();
        navigate(`/room/${curatorId}`);
      }}
    >
      {album.artwork ? (
        <img
          className="toast__art"
          src={artworkSrc(curatorId, album.artwork)}
          alt=""
        />
      ) : (
        <span className="toast__art" aria-hidden="true" />
      )}
      <span className="toast__body">
        <span className="toast__title">{album.title} is ready</span>
        {/* Names the needs, and only the needs — the lights stopped being one in ADR 0069. */}
        <span className="toast__sub">
          Visualizer, card and tags — all done. Tap to watch it.
        </span>
      </span>
    </button>
  );
}
