import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type AlbumAsset, type AlbumSummary } from "../api";
import { usePoll } from "../hooks";
import {
  NEED_ORDER,
  NEED_TAB_LABEL,
  outstandingNeeds,
  recordState,
  roadieNarration,
  stateLabel,
  type Need,
} from "../needs";
import { artworkSrc } from "../components/common";
import { errorMessage } from "../errors";
import { LightsPanel } from "../components/LightsPanel";
import { VisualizerPanel } from "../components/VisualizerPanel";
import { CardPanel } from "../components/CardPanel";
import { TagsPanel } from "../components/TagsPanel";
import type { Run } from "../run";

/**
 * The record (ADR 0052) — one page listing the four things a record still needs, done in any order.
 *
 * It replaces the five-station rail (Look → Video → Card → Preview → Ship), which asserted an order
 * the system does not have. There is no stepper, no machine-state name, and no readiness gate: every
 * tab is always open, because the reason you are here might be the artifact you are already holding.
 *
 * Preview is not a tab. Signing the lights off means having watched them, so that lives in the room.
 */
const isNeed = (s: string | undefined): s is Need =>
  NEED_ORDER.includes(s as Need);

export function Record({ albums }: { albums: AlbumSummary[] | null }) {
  const { curatorId = "", section } = useParams();
  const navigate = useNavigate();
  const {
    data: asset,
    error,
    refresh,
  } = usePoll<AlbumAsset>(() => api.album(curatorId), 3000, curatorId);
  const { data: gemini } = usePoll(api.geminiSettings, 30000);
  const [actionError, setActionError] = useState<string | null>(null);

  // Opening a record always lands on Lights, whatever is outstanding — the design's one fixed entry
  // point, so clicking a tile is predictable rather than dependent on state you can't see.
  const need: Need = isNeed(section) ? section : "lights";

  const run = useCallback<Run>(
    async (fn) => {
      setActionError(null);
      try {
        await fn();
        refresh();
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [refresh],
  );

  /**
   * The neighbours, in the order `GET /api/albums` returns them (newest first).
   *
   * Deliberately *not* `GET /api/albums/:id/peers`, which walks same-state buckets: that is the
   * nine-state model the collection no longer shows, so a run through it would step between records
   * by a rule nothing on screen explains. The run does not wrap — at the end the honest answer is
   * "that was the last one".
   */
  const peers = useMemo(() => {
    const i = albums?.findIndex((a) => a.curatorId === curatorId) ?? -1;
    if (!albums || i < 0) return { prev: null, next: null };
    return {
      prev: albums[i - 1] ?? null,
      next: albums[i + 1] ?? null,
    };
  }, [albums, curatorId]);

  if (error)
    return (
      <main className="record">
        <p className="pp-error">Couldn&apos;t load this record: {error}</p>
      </main>
    );
  if (!asset)
    return (
      <main className="record">
        <p className="pp-loading">Loading…</p>
      </main>
    );

  const summary = albums?.find((a) => a.curatorId === curatorId) ?? null;
  const state = summary ? recordState(summary) : null;
  const outstanding = summary ? outstandingNeeds(summary) : [];
  const colors = asset.palette?.colors ?? [];
  const go = (n: Need) => navigate(`/albums/${curatorId}/${n}`);

  return (
    <main className="record">
      <aside className="record__side">
        <Link to="/" className="pp-action">
          ← THE COLLECTION
        </Link>

        {asset.artwork ? (
          /* The contentHash is a freshness token, not decoration: this page polls every 3s, and a
             plain static src means a cover that lands *after* first paint — an override upload, or
             Roadie finishing the download — never appears (issue #25). */
          <img
            className="record__art"
            src={artworkSrc(curatorId, asset.artwork.contentHash)}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="record__art" aria-hidden="true" />
        )}

        {/* The live palette, as one ink-outlined strip — what the room will actually wash with. */}
        {colors.length > 0 && (
          <div className="record__strip" aria-hidden="true">
            {colors.map((c, i) => (
              <span key={`${c.hex}-${i}`} style={{ background: c.hex }} />
            ))}
          </div>
        )}

        <div>
          <h1 className="record__title">{asset.metadata.name}</h1>
          <p className="record__byline">
            {asset.metadata.year
              ? `${asset.metadata.artist} · ${asset.metadata.year}`
              : asset.metadata.artist}
          </p>
        </div>

        {state && (
          <p
            className={`record__state${state.kind === "ready" ? " record__state--ready" : ""}`}
          >
            {state.kind === "roadie"
              ? roadieNarration(asset.roadie.state)
              : stateLabel(state)}
          </p>
        )}

        <Link to={`/room/${curatorId}`} className="pp-btn record__toroom">
          ▶ SEE IT IN THE ROOM
        </Link>

        <div className="record__peers">
          <button
            type="button"
            className="pp-action"
            disabled={!peers.prev}
            title={peers.prev ? peers.prev.title : "This is the first record"}
            onClick={() =>
              peers.prev && navigate(`/albums/${peers.prev.curatorId}/${need}`)
            }
          >
            ↑ PREV
          </button>
          <button
            type="button"
            className="pp-action"
            disabled={!peers.next}
            title={peers.next ? peers.next.title : "That was the last one"}
            onClick={() =>
              peers.next && navigate(`/albums/${peers.next.curatorId}/${need}`)
            }
          >
            NEXT ↓
          </button>
          {/* The one place an id is allowed to appear: small, muted, and never in a sentence. */}
          <span className="record__id">{curatorId}</span>
        </div>
      </aside>

      <div className="record__main">
        <div className="record__tabs-head">
          <p className="pp-label">WHAT THIS RECORD STILL NEEDS</p>
          <nav
            className="record__tabs"
            aria-label="What this record still needs"
          >
            {NEED_ORDER.map((n) => {
              const done = !outstanding.includes(n);
              return (
                <button
                  key={n}
                  type="button"
                  className="record__tab"
                  aria-current={need === n ? "page" : undefined}
                  onClick={() => go(n)}
                >
                  {/* Filled or hollow, never colour alone — the glyph is the channel. */}
                  <span className="record__tab-glyph" aria-hidden="true">
                    {done ? "●" : "○"}
                  </span>
                  {NEED_TAB_LABEL[n]}
                  <span className="visually-hidden">
                    {done ? " — done" : " — still needed"}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="record__panel">
          {actionError && <p className="pp-error">{actionError}</p>}

          {need === "lights" && (
            <LightsPanel
              curatorId={curatorId}
              asset={asset}
              refresh={refresh}
              run={run}
            />
          )}
          {need === "visualizer" && (
            <VisualizerPanel
              curatorId={curatorId}
              asset={asset}
              refresh={refresh}
              run={run}
              canGenerate={gemini?.generateVideo ?? false}
            />
          )}
          {need === "card" && (
            <CardPanel
              curatorId={curatorId}
              asset={asset}
              refresh={refresh}
              run={run}
              canGenerate={gemini?.generateCardArt ?? false}
            />
          )}
          {need === "tags" && (
            <TagsPanel curatorId={curatorId} asset={asset} run={run} />
          )}
        </div>
      </div>
    </main>
  );
}
