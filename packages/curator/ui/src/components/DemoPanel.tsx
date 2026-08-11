import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type AlbumAsset,
  type SpotifyAlbumMeta,
  type Track,
} from "../api";
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

/**
 * The albums this record could be ([#289](https://github.com/dylanleatham/Marquee/issues/289)) —
 * fetched live, never stored, for the same reason the tracklist is: the list belongs to Spotify's
 * catalogue, not to this record, and it would go stale the moment an anniversary edition ships.
 *
 * The server does the deciding. This asks `/spotify-candidates` and renders what comes back rather
 * than filtering search results itself, so "which albums are indistinguishable" has exactly one
 * implementation — the matcher's ([ADR 0067](../../../../../docs/adrs/0067-the-year-may-only-break-a-tie-by-hitting-it.md)).
 */
function useSpotifyCandidates(curatorId: string) {
  const [state, setState] = useState<{
    candidates: SpotifyAlbumMeta[] | null;
    reason: string | null;
  }>({ candidates: null, reason: null });

  useEffect(() => {
    let live = true;
    setState({ candidates: null, reason: null });
    api
      .spotifyCandidates(curatorId)
      .then((r) => {
        if (live)
          setState({ candidates: r.candidates, reason: r.reason ?? null });
      })
      .catch((err: unknown) => {
        // Same rule as `useTracks`: a transport failure reads as the server's own `reason`, because
        // this panel has one place to say why there is nothing to choose.
        if (live) setState({ candidates: [], reason: errorMessage(err) });
      });
    return () => {
      live = false;
    };
  }, [curatorId]);

  return state;
}

function CandidatePicker({
  curatorId,
  onPick,
}: {
  curatorId: string;
  onPick: (spotifyUri: string) => Promise<unknown>;
}) {
  const { candidates, reason } = useSpotifyCandidates(curatorId);

  if (candidates === null && !reason)
    return <p className="demo__uri-hint">Asking Spotify…</p>;

  if (!candidates?.length)
    return (
      <p className="demo__uri-hint">
        {reason ?? "Spotify had nothing to offer for this record."}
      </p>
    );

  return (
    <>
      {/* Points at the sleeve, not the year. The year is what misled the matcher in the first place
          (ADR 0067: a repress's year dates the vinyl, not the album), so telling someone to settle
          it that way would hand them the same bad evidence. The cover is the one they can check
          against the record in their hand. */}
      <p className="demo__uri-hint">
        The albums Curator couldn't tell apart — match the sleeve to the one on
        your shelf:
      </p>
      <ul className="demo__candidates">
        {candidates.map((c) => (
          <li key={c.spotifyUri} className="demo__candidate">
            {/* The cover is the fastest way to recognise your own sleeve — far faster than a year,
                and it is the whole reason six identically-named rows are distinguishable at all. */}
            {c.artUrl && (
              <img className="demo__candidate-art" src={c.artUrl} alt="" />
            )}
            <span className="demo__candidate-name">
              {c.name}
              {c.year ? ` (${c.year})` : ""}
            </span>
            <AsyncButton
              className="pp-action"
              pendingLabel="SAVING…"
              onClick={() => onPick(c.spotifyUri)}
            >
              THIS ONE
            </AsyncButton>
          </li>
        ))}
      </ul>
    </>
  );
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
 * Which Spotify album this record is, and how to change it (ADR 0059, made always-visible by
 * [ADR 0060](../../../../../docs/adrs/0060-the-year-is-a-tiebreak-not-a-gate.md)).
 *
 * **Shown whether or not a match exists**, which is the whole point of the revision. The first
 * version only appeared when there was no tracklist, so it could fix a *missing* match and not a
 * *wrong* one — and once ADR 0060 loosened the rule, wrong-edition matches became the failure to
 * expect. A wrong match is exactly the case where songs appear and they are the wrong songs, so the
 * control has to be next to them.
 *
 * ADR 0060 leans on this: the looser rule is only the right trade because a mistake is visible here
 * and correctable in one press.
 */
function SpotifyAlbumControl({
  curatorId,
  metadata,
  run,
}: {
  curatorId: string;
  metadata: AlbumAsset["metadata"];
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const linked = Boolean(metadata.spotifyUri);
  const match = metadata.spotifyMatch;
  /** Refused as un-tellable-apart (#289) — a different state from "never matched", and the only one
   *  where this panel is the sole fix, since the library sweep declines it on every run. */
  const ambiguous = !linked ? metadata.spotifyAmbiguous : undefined;

  const save = () =>
    run(async () => {
      await api.setSpotifyUri(curatorId, value.trim());
      setEditing(false);
      setValue("");
    });

  return (
    <div className="demo__uri">
      <p className="demo__uri-label">This record on Spotify</p>

      {/* What it is now, in words. A guessed match says so and names what it guessed, because
          "matched automatically" and "you told me" are different degrees of certainty. */}
      <p className="demo__uri-state">
        {linked ? (
          match ? (
            <>
              matched automatically to{" "}
              <strong>
                {match.artist} — {match.name}
              </strong>
              {match.year ? ` (${match.year})` : ""}
            </>
          ) : (
            <>
              linked
              {metadata.source === "spotify"
                ? " — added from Spotify"
                : " by hand"}
            </>
          )
        ) : ambiguous ? (
          /* Names the situation rather than the absence. "not linked" invites you to go and run the
             sweep; this says the sweep already looked, found several, and stopped on purpose. */
          <>
            <strong>{ambiguous.candidateCount} albums</strong> by this artist
            share this title, so Curator wouldn't guess which one you own
          </>
        ) : (
          <>not linked to a Spotify album</>
        )}
      </p>

      {!editing && (
        <div className="demo__uri-row">
          <button
            type="button"
            className="pp-action"
            onClick={() => setEditing(true)}
          >
            {linked
              ? "USE A DIFFERENT ALBUM"
              : ambiguous
                ? "CHOOSE THE RIGHT ALBUM"
                : "PASTE THE ALBUM"}
          </button>
          {linked && (
            <AsyncButton
              className="pp-action"
              pendingLabel="CLEARING…"
              title="Unlinks the album — the demo cut goes with it"
              onClick={() => run(() => api.setSpotifyUri(curatorId, null))}
            >
              UNLINK
            </AsyncButton>
          )}
        </div>
      )}

      {editing && (
        <>
          <div className="demo__uri-row">
            <input
              id={`spotify-uri-${curatorId}`}
              className="demo__uri-input"
              aria-label="Paste this record on Spotify"
              value={value}
              autoFocus
              placeholder="https://open.spotify.com/album/… or spotify:album:…"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) void save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <AsyncButton
              className="pp-btn"
              disabled={!value.trim()}
              pendingLabel="SAVING…"
              onClick={save}
            >
              USE THIS ALBUM
            </AsyncButton>
            <button
              type="button"
              className="pp-action"
              onClick={() => setEditing(false)}
            >
              CANCEL
            </button>
          </div>
          {/* The picker leads, the paste box stays: for an ambiguous record the answer is almost
              always one of these, and hunting the share link for an album Curator already has in
              hand is work nobody should have to do. */}
          {ambiguous && (
            <CandidatePicker
              curatorId={curatorId}
              onPick={(spotifyUri) =>
                run(async () => {
                  await api.setSpotifyUri(curatorId, spotifyUri);
                  setEditing(false);
                })
              }
            />
          )}
          <p className="demo__uri-hint">
            {ambiguous ? (
              /* Deliberately *not* the sweep link here: it is the one action that cannot resolve
                 this record, and offering it is what #289 was filed about. */
              <>
                The library sweep can't settle this one — it will refuse it
                again every time it runs.
              </>
            ) : (
              <>
                Or match the whole collection at once from{" "}
                <Link to="/settings">Settings → Library</Link>.
              </>
            )}
          </p>
        </>
      )}
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
        <p className="demo__reason">
          {reason ?? "No songs came back for this record."}
        </p>
      )}

      {/* Always, not only when the list is empty (ADR 0060): the case this has to reach is a match
          that produced the *wrong* songs, and those are right below it. */}
      <SpotifyAlbumControl
        curatorId={curatorId}
        metadata={asset.metadata}
        run={run}
      />

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
