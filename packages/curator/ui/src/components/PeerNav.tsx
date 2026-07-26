// "Next album at this state" (issue #94) — the in-session flow affordance.
//
// album-onboarding-workflow §12: after finishing an album the question is "am I in a flow?" If yes,
// the next album at the same state should be one keystroke away. Without this you return to the
// queue and find your place again, ten times a session.
//
// Navigation keeps the **workstation** you're on: finishing five tag writes in a row shouldn't
// bounce you back to Look each time.
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { QUEUE_LABEL } from "../format";
import type { PeerContext, Peer } from "../api";

/** Where a peer link should land: the workstation you're already using, if you're on one. */
const peerHref = (peer: Peer, section?: string) =>
  `/albums/${peer.curatorId}${section ? `/${section}` : ""}`;

export function PeerNav({
  peers,
  section,
}: {
  peers: PeerContext | null;
  /** The rail segment currently open, carried across so a run of the same work stays in place. */
  section?: string;
}) {
  const navigate = useNavigate();

  // `[` / `]` (curator-ui-ux §9.1). Read from the latest render's props via the effect deps rather
  // than a stale closure — the same rule issue #119 established for the queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target =
        e.key === "[" ? peers?.prev : e.key === "]" ? peers?.next : null;
      if (!target) return;
      e.preventDefault();
      navigate(peerHref(target, section));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peers, section, navigate]);

  if (!peers) return null;

  const label = QUEUE_LABEL[peers.bucket] ?? peers.bucket;
  // Alone at this state is a real answer, not an empty one — say it rather than hiding the control
  // (curator-ui-ux §10: a disabled control always carries its reason).
  const alone = peers.total <= 1;

  return (
    <nav className="peernav" aria-label={`Other albums ${label.toLowerCase()}`}>
      <button
        className="btn btn--ghost btn--small"
        disabled={!peers.prev}
        title={
          peers.prev
            ? `Previous: ${peers.prev.title}  [`
            : alone
              ? `No other albums ${label.toLowerCase()}`
              : "This is the first one"
        }
        onClick={() => peers.prev && navigate(peerHref(peers.prev, section))}
      >
        ← Prev
      </button>
      <span className="peernav__count">
        {peers.position} of {peers.total} <em>{label.toLowerCase()}</em>
      </span>
      <button
        className="btn btn--ghost btn--small"
        disabled={!peers.next}
        title={
          peers.next
            ? `Next: ${peers.next.title}  ]`
            : alone
              ? `No other albums ${label.toLowerCase()}`
              : "This is the last one"
        }
        onClick={() => peers.next && navigate(peerHref(peers.next, section))}
      >
        Next →
      </button>
    </nav>
  );
}
