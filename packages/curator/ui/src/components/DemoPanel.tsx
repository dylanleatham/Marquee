import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AlbumAsset, type Track } from "../api";
import { errorMessage } from "../errors";
import { AsyncButton } from "./common";
import type { Run } from "../run";

/**
 * The demo track (ADR 0058) — which one song a demo tag plays.
 *
 * **This tab is not a need.** The four the record page lists are things every record must have
 * before it goes on the shelf; a demo track is a preference most records never express. So it
 * carries no `●`/`○` glyph, never appears on a collection tile, and nothing anywhere says a record
 * is missing one. It sits after the needs, past a rule, as a choice you may make.
 *
 * **What it does not do is as deliberate as what it does.** There is no "preview" button: judging
 * whether a song is the one that makes someone put the record on is a thing you do by listening in
 * the room, and the room already has audio. Adding a second, quieter way to play a track here would
 * make the honest answer ("go listen to it properly") the harder one.
 *
 * **A chosen track and no track are both valid.** No choice means the demo tag plays the album from
 * track 1, exactly as a shelf card does — so clearing is safe and is labelled as what it is, not as
 * a deletion.
 */

const mmss = (ms: number): string => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** The tracklist, fetched live per album — it is never stored, so it is never on the asset. */
function useTracks(curatorId: string) {
  const [state, setState] = useState<{
    tracks: Track[] | null;
    reason: string | null;
  }>({ tracks: null, reason: null });

  useEffect(() => {
    let live = true;
    setState({ tracks: null, reason: null });
    api
      .tracks(curatorId)
      .then((r) => {
        if (live) setState({ tracks: r.tracks, reason: r.reason ?? null });
      })
      .catch((err: unknown) => {
        // A transport failure reads the same way as the server's own `reason`: this panel has one
        // place to say why there is no list, and which layer failed is not the producer's problem.
        if (live) setState({ tracks: [], reason: errorMessage(err) });
      });
    return () => {
      live = false;
    };
  }, [curatorId]);

  return state;
}

/** One row: its number, its name, its length, and whichever action it currently offers. */
function TrackRow({
  track,
  chosen,
  onChoose,
}: {
  track: Track;
  chosen: boolean;
  onChoose: () => unknown;
}) {
  return (
    <li className={`demotrack${chosen ? " demotrack--chosen" : ""}`}>
      {/* Filled or hollow, never colour alone — the glyph is the channel (curator-ui-ux §3.4). */}
      <span className="demotrack__glyph" aria-hidden="true">
        {chosen ? "●" : "○"}
      </span>
      <span className="demotrack__no">{track.trackNumber}</span>
      <span className="demotrack__name">{track.name}</span>
      <span className="demotrack__len">
        {track.durationMs ? mmss(track.durationMs) : ""}
      </span>
      {chosen ? (
        // "IN USE", matching the card gallery — the app has one word for "this is the one".
        <span className="demotrack__inuse">IN USE</span>
      ) : (
        <AsyncButton
          className="pp-action demotrack__pick"
          onClick={onChoose}
          pendingLabel="CHOOSING…"
        >
          USE THIS ONE
        </AsyncButton>
      )}
    </li>
  );
}

/**
 * Name the album on Spotify by hand — the escape hatch for a record the matcher missed, or matched
 * only closely and refuses to play from (ADR 0059).
 *
 * Takes the share link as well as the URI, because the share button is where anyone actually gets
 * this and demanding the `spotify:album:` form would mean explaining a conversion. The library-wide
 * sweep is a link rather than a button here: it is the answer for *hundreds* of records, and putting
 * it next to a single album invites running it to fix one.
 */
function SpotifyUriEntry({ curatorId, run }: { curatorId: string; run: Run }) {
  const [value, setValue] = useState("");

  return (
    <div className="demo__uri">
      <label className="demo__uri-label" htmlFor={`spotify-uri-${curatorId}`}>
        Paste this record on Spotify
      </label>
      <div className="demo__uri-row">
        <input
          id={`spotify-uri-${curatorId}`}
          className="demo__uri-input"
          value={value}
          placeholder="https://open.spotify.com/album/… or spotify:album:…"
          onChange={(e) => setValue(e.target.value)}
        />
        <AsyncButton
          className="pp-btn"
          disabled={!value.trim()}
          pendingLabel="SAVING…"
          onClick={() => run(() => api.setSpotifyUri(curatorId, value.trim()))}
        >
          USE THIS ALBUM
        </AsyncButton>
      </div>
      <p className="demo__uri-hint">
        Or match the whole collection at once from{" "}
        <Link to="/settings">Settings → Library</Link>.
      </p>
    </div>
  );
}

export function DemoPanel({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const { tracks, reason } = useTracks(curatorId);
  const chosen = asset.demoTrack ?? null;

  const choose = (t: Track) =>
    run(() =>
      api.setDemoTrack(curatorId, {
        spotifyUri: t.spotifyUri,
        name: t.name,
        trackNumber: t.trackNumber,
        durationMs: t.durationMs,
      }),
    );

  return (
    <div className="demo">
      <div className="demo__head">
        <p className="pp-label">THE DEMO CUT</p>
        <p className="pp-prose demo__intro">
          A <strong>demo tag</strong> plays one song instead of the whole record
          — the one that makes someone want to hear the rest.
        </p>
      </div>

      {/* What is chosen, said in words before any list. Also the honest answer when nothing is. */}
      <div className="demo__chosen">
        {chosen ? (
          <>
            <p className="demo__chosen-name">{chosen.name}</p>
            <p className="demo__chosen-sub">
              {chosen.trackNumber ? `Track ${chosen.trackNumber}` : "Chosen"}
              {chosen.durationMs ? ` · ${mmss(chosen.durationMs)}` : ""}
            </p>
            <AsyncButton
              className="pp-action"
              onClick={() => run(() => api.setDemoTrack(curatorId, null))}
              pendingLabel="CLEARING…"
              title="The demo tag goes back to playing the whole record"
            >
              PLAY THE WHOLE RECORD INSTEAD
            </AsyncButton>
          </>
        ) : (
          <p className="demo__chosen-none">
            No demo cut chosen — a demo tag plays the whole record, just like
            the shelf card does.
          </p>
        )}
      </div>

      {tracks === null && <p className="pp-loading">Reading the tracklist…</p>}

      {tracks !== null && tracks.length === 0 && (
        <div className="demo__reason">
          <p>{reason ?? "No songs came back for this record."}</p>
          {/* The way out, next to the explanation rather than somewhere else (ADR 0059). Until this
              existed the copy suggested pasting a URI and offered nowhere to paste it. */}
          <SpotifyUriEntry curatorId={curatorId} run={run} />
        </div>
      )}

      {tracks !== null && tracks.length > 0 && (
        <ol className="demo__list">
          {tracks.map((t) => (
            <TrackRow
              key={t.spotifyUri}
              track={t}
              chosen={chosen?.spotifyUri === t.spotifyUri}
              onChoose={() => choose(t)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
