// System status — "what is the whole thing doing right now", in one place.
//
// The problem this solves is not that any one service lacks a status endpoint; it is that the
// failures worth catching are *disagreements between hosts*, and answering them meant curling four
// services and diffing the results by hand. The album table below is the heart of the page for that
// reason: it is the only view that says "Curator has thirteen albums and the runtime has six".
//
// Read-only apart from one button. This is the page you open when something is wrong, so it must
// never be the reason something is wrong.
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AlbumPresence, type SystemStatus } from "../api";
import { usePoll } from "../hooks";
import { AsyncButton, Spinner } from "../components/common";
import { ServiceHealthList } from "../components/ServiceHealthList";

/**
 * A present/absent cell. Never colour alone (curator-ui-ux §3.4) — the glyph carries the meaning and
 * the `title` says what it means for that specific column, because "no" is not equally bad
 * everywhere: an album with no video attached is mid-workflow, one missing from Conductor is broken.
 */
function Cell({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <td className={`matrix__cell matrix__cell--${ok ? "yes" : "no"}`}>
      <span title={ok ? yes : no}>{ok ? "✓" : "—"}</span>
      <span className="visually-hidden">{ok ? yes : no}</span>
    </td>
  );
}

function AlbumRow({ album }: { album: AlbumPresence }) {
  // An album is only truly playable when every host has its part. Stated as a word, not a colour.
  const ready =
    album.hasVideo &&
    album.onConductor &&
    album.inBackdropLibrary &&
    album.videoOnBackdrop;
  return (
    <tr>
      <th scope="row">
        <Link to={`/albums/${album.curatorId}`}>{album.name}</Link>
        <span className="muted"> — {album.artist}</span>
      </th>
      <Cell
        ok={album.hasVideo}
        yes="Visualizer attached"
        no="No visualizer attached yet"
      />
      <Cell
        ok={album.onConductor}
        yes="Conductor has the asset — lights will react"
        no="Conductor has never been given this album — a scan will do nothing"
      />
      <Cell
        ok={album.inBackdropLibrary}
        yes="Backdrop can resolve the scan URI"
        no="Not in Backdrop's library"
      />
      <Cell
        ok={album.videoOnBackdrop}
        yes="The video file is on Backdrop's disk"
        no="Backdrop has no playable file (or is too old to report)"
      />
      <td>{ready ? "Ready" : "Incomplete"}</td>
    </tr>
  );
}

/** The scan-URI shape Stylus's state machine will act on (contracts `parseCuratorUri`). */
const CURATOR_URI = /^curator:(album|card):[a-z0-9]{8}$/;

function StylusPanel({ stylus }: { stylus: SystemStatus["stylus"] }) {
  if (!stylus)
    return (
      <p className="muted">
        Stylus isn't reachable, so nothing can be said about the stand. Set{" "}
        <code>STYLUS_URL</code> if it has never been configured.
      </p>
    );

  const observed = stylus.observed;
  // Three distinguishable outcomes where /status used to show one blank (stylus-spec §8). The third
  // — decoded, but not something the machine will act on — matters most: it is the tag that looks
  // fine from every angle and still does nothing, so it must not render like a working read.
  //
  // Judged on the URI's shape rather than by waiting for it to become `lastUri`, because a *valid*
  // tag isn't `lastUri` until the insertion debounce fires either; shape is the same test the state
  // machine applies, and it is true immediately.
  const sleeve = !observed
    ? "Nothing on the stand"
    : observed.uri === null
      ? "A tag is on the stand, but its NDEF won't decode"
      : CURATOR_URI.test(observed.uri)
        ? `Reading ${observed.uri}`
        : `A tag is on the stand carrying ${observed.uri} — not a Marquee URI, so no scan will fire`;

  return (
    <>
      <p>
        <b>Stand:</b> {sleeve}
        {observed && <code className="health__url">uid {observed.uid}</code>}
      </p>
      <p>
        <b>Machine:</b>{" "}
        {stylus.lastUri
          ? `playing ${stylus.lastUri}`
          : "idle — no scan has fired"}
      </p>
      {stylus.lastBadTag && (
        <p className="muted">
          Last refused: <code>{stylus.lastBadTag.uid}</code>
          {stylus.lastBadTag.uri
            ? ` carrying ${stylus.lastBadTag.uri}`
            : " (unreadable)"}{" "}
          at {stylus.lastBadTag.at}
        </p>
      )}
    </>
  );
}

export function SystemStatus() {
  /**
   * Coalesce overlapping polls onto one in-flight request.
   *
   * `usePoll` is `setInterval`-based, so it does not wait for the previous fetch. That is fine for
   * the small endpoints its other callers use, but this one fans out to four services and each
   * probe is bounded at 5s — so when the runtime is *down*, which is exactly when this page is
   * open, a request takes about as long as the interval and the next one lands on top of it. Left
   * alone that piles up overlapping fan-outs against a host that is already not answering.
   *
   * A poll arriving while one is in flight now awaits that same promise instead of issuing a second.
   */
  const inFlight = useRef<Promise<SystemStatus> | null>(null);
  const fetchStatus = useCallback(() => {
    if (!inFlight.current) {
      inFlight.current = api.systemStatus().finally(() => {
        inFlight.current = null;
      });
    }
    return inFlight.current;
  }, []);

  const { data, error, loading, refresh } = usePoll<SystemStatus>(
    fetchStatus,
    5000,
  );
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const syncEverything = async () => {
    setSyncMsg(null);
    try {
      const job = await api.runtimeSync();
      setSyncMsg(`Sync started (job ${job.id}). Progress appears below.`);
      refresh();
    } catch (err) {
      setSyncMsg(
        `Couldn't start the sync: ${
          err instanceof ApiError ? err.message : String(err)
        }`,
      );
    }
  };

  if (error)
    return (
      <div className="page page--wide">
        <div className="banner banner--error">
          Couldn't load system status: {String(error)}
        </div>
      </div>
    );
  if (!data && loading)
    return (
      <div className="page page--wide">
        <p className="muted">
          <Spinner /> Reading the runtime…
        </p>
      </div>
    );
  if (!data) return null;

  const missingFromRuntime = data.albums.filter((a) => !a.onConductor).length;
  const unplayable = data.albums.filter(
    (a) => a.hasVideo && !a.videoOnBackdrop,
  ).length;

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>System status</h1>
        <div className="row-actions">
          <AsyncButton
            className="btn btn--primary"
            onClick={syncEverything}
            pendingLabel="Starting…"
          >
            Sync everything
          </AsyncButton>
        </div>
      </div>
      <p className="muted">
        Polled every 5s. Read-only apart from the sync button — this is the page
        you open when something is wrong.
      </p>
      {syncMsg && <div className="banner banner--ok">{syncMsg}</div>}

      <section className="queue-section">
        <h2>Services</h2>
        <ServiceHealthList health={data.services} />
      </section>

      <section className="queue-section">
        <h2>Playing now</h2>
        <p>
          <b>Video:</b>{" "}
          {!data.playing.video
            ? "Backdrop unreachable"
            : data.playing.video.state === "playing"
              ? `${data.playing.video.uri}`
              : "idle"}
          {data.playing.video &&
            data.playing.video.browserConnected === false && (
              <em> — no kiosk browser attached</em>
            )}
        </p>
        <p>
          <b>Lights:</b>{" "}
          {!data.playing.lights
            ? "Conductor unreachable"
            : data.playing.lights.length === 0
              ? "idle"
              : data.playing.lights
                  .map(
                    (p) =>
                      `${p.source?.name ?? "unknown"} in room ${p.roomId}${
                        p.pattern ? ` (${p.pattern})` : ""
                      }`,
                  )
                  .join(", ")}
        </p>
        <p>
          <b>Audio:</b>{" "}
          {!data.playing.audio
            ? "Amp unreachable"
            : `${data.playing.audio.state ?? "unknown"}${
                data.playing.audio.target
                  ? ` → ${data.playing.audio.target}`
                  : ""
              }`}
        </p>
        {data.playing.caveats.map((c) => (
          <p className="muted" key={c}>
            {c}
          </p>
        ))}
      </section>

      <section className="queue-section">
        <h2>The stand</h2>
        <StylusPanel stylus={data.stylus} />
      </section>

      <section className="queue-section">
        <h2>In flight</h2>
        {data.jobs.length === 0 ? (
          <p className="muted">Nothing running.</p>
        ) : (
          <ul className="legs">
            {data.jobs.map((j) => (
              <li className="legs__item" key={j.id}>
                <b>{j.kind}</b>
                {j.curatorId ? ` · ${j.curatorId}` : " · library-wide"} ·{" "}
                {j.progress.done}/{j.progress.total}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="queue-section">
        <h2>Albums across the system</h2>
        <p className="muted">
          {data.albums.length} in Curator · {missingFromRuntime} not on
          Conductor · {unplayable} with a video Backdrop can't play
        </p>
        <div className="matrix__scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Album</th>
                <th scope="col">Video attached</th>
                <th scope="col">On Conductor</th>
                <th scope="col">In Backdrop library</th>
                <th scope="col">Video on Backdrop</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {data.albums.map((a) => (
                <AlbumRow key={a.curatorId} album={a} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
