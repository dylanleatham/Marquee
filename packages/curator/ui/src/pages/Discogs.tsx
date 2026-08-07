import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AlbumSummary } from "../api";
import { usePoll } from "../hooks";
import { artworkSrc, AsyncButton } from "../components/common";
import { errorMessage } from "../errors";
import { cameInToday, discogsCounts, lastSynced, unmatched } from "../discogs";
import { recordState, roadieNarration, stateLabel } from "../needs";
import { startDiscogsSync } from "../discogsSyncJob";

/**
 * Your Discogs collection (ADR 0052) — a **synced collection**, not an album picker.
 *
 * The old Discogs tab paged through the collection with a "Send to Roadie" button per row, which is
 * the right shape for adding one record and the wrong shape for owning several hundred. ADR 0051
 * made the sweep the unit of work; this screen is what that looks like: counts, what arrived, and
 * the only thing left that needs a person.
 *
 * **There is no import step and nothing to approve.** Everything that could be matched is already in
 * the collection by the time you look.
 */

/** One tile in the "came in today" grid — the same vocabulary the collection uses. */
function Arrival({ album }: { album: AlbumSummary }) {
  const state = recordState(album);
  const label =
    state.kind === "roadie" ? roadieNarration(album.state) : stateLabel(state);
  return (
    <Link to={`/albums/${album.curatorId}`} className="arrival">
      {album.artwork ? (
        <img
          className={`arrival__art${state.kind === "roadie" ? " arrival__art--roadie" : ""}`}
          src={artworkSrc(album.curatorId, album.artwork)}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="arrival__art arrival__art--none" aria-hidden="true" />
      )}
      <span className="arrival__title">{album.title || "Untitled"}</span>
      <span
        className={`arrival__state${state.kind === "ready" ? " arrival__state--ready" : ""}`}
      >
        {label}
      </span>
    </Link>
  );
}

export function Discogs({ albums }: { albums: AlbumSummary[] | null }) {
  const { data: sync, refresh: refreshSync } = usePoll(
    api.discogsSyncStatus,
    5000,
  );
  const { data: settings } = usePoll(api.discogsSettings, 30000);
  const [inDiscogs, setInDiscogs] = useState<number | null>(null);
  const [reachError, setReachError] = useState<string | null>(null);
  const [syncProblem, setSyncProblem] = useState<string | null>(null);
  /**
   * Skipped this session only. The list is deliberately durable — "they never leave on their own" —
   * so this hides a row you have decided not to deal with today without pretending it is resolved.
   */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  // The one number that isn't already in the library: how big the collection is upstream. One row is
  // enough — the response carries the total.
  useEffect(() => {
    api
      .discogsCollection(1, 1)
      .then((p) => setInDiscogs(p.total))
      .catch((err: unknown) => setReachError(errorMessage(err)));
  }, []);

  const list = albums ?? [];
  const counts = discogsCounts(list, inDiscogs);
  const arrivals = cameInToday(list);
  const stuck = unmatched(list).filter((u) => !skipped.has(u.album.curatorId));

  if (settings && !settings.configured)
    return (
      <main className="screen">
        <header className="screen__head">
          <h1 className="pp-title screen__title">Your Discogs collection</h1>
        </header>
        <div className="screen__body">
          <p className="pp-prose">
            Curator isn&apos;t connected to Discogs yet.{" "}
            <Link to="/settings">Connect it in Settings</Link> and it will bring
            your collection in and keep it current.
          </p>
        </div>
      </main>
    );

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="pp-title screen__title">Your Discogs collection</h1>
        {/* Kept for when you have just added something and don't want to wait for the poll. */}
        <AsyncButton
          className="pp-btn pp-btn--outline"
          onClick={async () => {
            setSyncProblem(null);
            try {
              await startDiscogsSync();
              refreshSync();
            } catch (err) {
              // AsyncButton only catches so it doesn't throw — without this the button would settle
              // back to SYNC NOW and nothing would say the sweep never started.
              setSyncProblem(errorMessage(err));
            }
          }}
          pendingLabel="SYNCING…"
        >
          SYNC NOW
        </AsyncButton>
      </header>

      <section
        className="statband"
        aria-label="Your Discogs collection at a glance"
      >
        <div className="statband__cell">
          <p className="pp-label">IN DISCOGS</p>
          {/* An unknown count is not zero — Discogs may simply not have answered. */}
          <p className="statband__n statband__n--sm">
            {counts.inDiscogs ?? "—"}
          </p>
        </div>
        <div className="statband__cell">
          <p className="pp-label">IN CURATOR</p>
          <p className="statband__n statband__n--sm">{counts.inCurator}</p>
        </div>
        <div className="statband__cell">
          <p className="pp-label">CAME IN TODAY</p>
          <p className="statband__n statband__n--sm">{counts.today}</p>
        </div>
        <div className="statband__cell statband__cell--wide">
          <p className="pp-label">LAST SYNCED</p>
          <p className="statband__detail statband__detail--lg">
            {lastSynced(sync?.lastRunAt, Boolean(sync?.enabled))}
          </p>
        </div>
      </section>

      <div className="screen__body">
        {syncProblem && (
          <p className="pp-error">
            Couldn&apos;t start the sync: {syncProblem}
          </p>
        )}
        {reachError && (
          <p className="pp-error">
            Couldn&apos;t reach Discogs for the collection size: {reachError}
          </p>
        )}

        <section>
          <p className="discogs__head">
            <span className="pp-label">CAME IN TODAY · {arrivals.length}</span>
            <span className="discogs__sub">
              already in your collection — nothing to approve
            </span>
          </p>
          {arrivals.length === 0 ? (
            <p className="pp-prose">
              Nothing new today. The next check brings anything you have added
              since.
            </p>
          ) : (
            <div className="arrivals">
              {arrivals.map((a) => (
                <Arrival key={a.curatorId} album={a} />
              ))}
            </div>
          )}
        </section>

        {stuck.length > 0 && (
          <section className="discogs__stuck">
            {/*
             * The design says "COULDN'T MATCH TO SPOTIFY", which names a state a Discogs record
             * cannot reach — see `unmatched()`. This is what the list actually holds.
             */}
            <p className="pp-label pp-label--accent">
              ROADIE COULDN&apos;T FINISH THESE · {stuck.length}
            </p>
            <p className="discogs__sub">
              These stay here until you deal with them — they never leave this
              list on their own.
            </p>
            {stuck.map(({ album, why }) => (
              <div className="unmatched" key={album.curatorId}>
                <p className="unmatched__what">
                  <b>{album.title || "Untitled"}</b>{" "}
                  <span className="unmatched__why">— {why}</span>
                </p>
                {/* Searching by hand is the Add screen with the name already in it. */}
                <Link
                  className="pp-btn"
                  to={`/add?q=${encodeURIComponent(album.title || "")}`}
                >
                  SEARCH BY HAND
                </Link>
                <button
                  type="button"
                  className="unmatched__skip"
                  title="Hides it until Curator restarts. It stays in your collection either way."
                  onClick={() =>
                    setSkipped((s) => new Set(s).add(album.curatorId))
                  }
                >
                  SKIP
                </button>
              </div>
            ))}
          </section>
        )}

        <p className="discogs__foot">
          Multiple pressings of the same record collapse into one. Removing
          something in Discogs leaves it here —{" "}
          <Link to="/">delete it from your collection</Link> if you want it
          gone.
        </p>
      </div>
    </main>
  );
}
