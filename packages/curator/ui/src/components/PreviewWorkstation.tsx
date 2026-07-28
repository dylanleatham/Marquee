// The Preview workstation (ADR 0028 / curator-ui-ux §6). Two modes, and the split is a safety
// property, not a style: the listening room may have other people in it, so taking over their lights
// and starting music is a side effect on humans.
//
//  - Bench  — everything in the window. Touches no hardware, ever. The default, always available.
//  - Room   — the real runtime path minus the physical tag, behind the room-arm switch.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  videoUrl,
  thumbnailUrl,
  type AlbumAsset,
  type RehearsalLeg,
} from "../api";
import { Cover, AsyncButton } from "./common";
import { useVisibleCycle } from "../hooks";
import { useRoomGate } from "../roomArm";
import type { Run } from "./workflow";

/** The palette animating under the runtime's own pattern — the light show, at the bench. */
function PaletteStage({
  colors,
  holdMs,
}: {
  colors: Array<{ hex: string }>;
  holdMs: number;
}) {
  // Gated: no re-renders for a light show nobody is looking at (issue #136).
  const { index, ref } = useVisibleCycle(colors.length, holdMs);
  return (
    <div
      ref={ref}
      className="palette-stage"
      style={{
        background: colors[index]?.hex ?? "#000",
        transition: `background ${Math.min(holdMs / 2, 4000)}ms ease-in-out`,
      }}
    />
  );
}

const SERVICE_LABEL: Record<RehearsalLeg["service"], string> = {
  conductor: "Lights",
  backdrop: "Display",
  amp: "Audio",
};

/** Per-leg outcome of a rehearsal. A dead service degrades the rehearsal; it never fails it. */
function LegReport({ legs }: { legs: RehearsalLeg[] }) {
  return (
    <ul className="legs">
      {legs.map((l) => (
        <li
          key={l.service}
          className={`legs__item legs__item--${l.ok ? "ok" : "off"}`}
        >
          {/* Colour is never the only channel (curator-ui-ux §3.4). */}
          <span aria-hidden="true" className="legs__dot" />
          <b>{SERVICE_LABEL[l.service]}</b> {l.ok ? "running" : "not running"}
          {l.reason ? <em> — {l.reason}</em> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Bench preview's audio leg (ADR 0037, issue #93): the album on the workstation's own Spotify
 * client, via a Connect transfer Curator proxies.
 *
 * Two things this control owes the producer, both from the ADR. It **says it takes over Spotify**
 * rather than reading as an anonymous play button — the transfer really does replace whatever they
 * were listening to. And it **pauses when the bench goes away** (leaving Preview, or switching to
 * room rehearsal, unmounts this), so desk audio never outlives the screen that started it.
 *
 * Nothing here touches hardware: the server only ever targets a local `Computer` device.
 */
function DeskAudio({
  curatorId,
  spotifyUri,
}: {
  curatorId: string;
  spotifyUri?: string;
}) {
  const [device, setDevice] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // Refs as well as state: the unmount cleanup below runs after the last render and would
  // otherwise close over whatever `device` was when the effect was created.
  const playing = useRef(false);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      if (playing.current) void api.deskAudioPause(curatorId).catch(() => {});
    },
    [curatorId],
  );

  /** Pause without touching state — for a desk that started after its screen was gone. */
  const pauseDetached = () => {
    playing.current = false;
    void api.deskAudioPause(curatorId).catch(() => {});
  };

  // Both handlers catch: the server reports its own failures as `reason`, but a request that never
  // reached it (Curator down, network) would otherwise leave the button idle with nothing said —
  // and a failed action never silently reverts (§10).
  const start = async () => {
    try {
      const r = await api.deskAudioPlay(curatorId);
      playing.current = r.played;
      // Navigating away while Spotify was still starting: the cleanup above already ran and saw
      // nothing playing, so this is the only place left that can stop it.
      if (!mounted.current) {
        if (r.played) pauseDetached();
        return;
      }
      setDevice(r.played ? (r.device ?? "this machine") : null);
      setReason(
        r.played ? null : (r.reason ?? "Spotify didn't start the album"),
      );
    } catch (err) {
      playing.current = false;
      if (!mounted.current) return;
      setDevice(null);
      setReason(`Couldn't reach Curator — ${(err as Error).message}`);
    }
  };

  // A pause that didn't happen leaves the control showing "pause" and says why — reverting to the
  // play button would claim silence that isn't there.
  const stop = async () => {
    try {
      const r = await api.deskAudioPause(curatorId);
      playing.current = !r.paused;
      if (r.paused) {
        setDevice(null);
        setReason(null);
      } else {
        setReason(r.reason ?? "Spotify didn't pause");
      }
    } catch (err) {
      setReason(`Couldn't reach Curator — ${(err as Error).message}`);
    }
  };

  // An album that was never on Spotify has nothing to transfer. Say so up front rather than make
  // the producer click to find out — a disabled control always carries its reason (§4).
  if (!spotifyUri)
    return (
      <div className="desk-audio">
        <button className="btn" disabled title="This album has no Spotify URI">
          ▶ Play at the desk
        </button>
        <p className="muted preview__note">
          This album isn't on Spotify, so there's nothing to play at the desk.
        </p>
      </div>
    );

  return (
    <div className="desk-audio">
      {device ? (
        <AsyncButton className="btn" onClick={stop} pendingLabel="Pausing…">
          ⏸ Pause desk audio
        </AsyncButton>
      ) : (
        <AsyncButton className="btn" onClick={start} pendingLabel="Starting…">
          ▶ Play at the desk — takes over Spotify
        </AsyncButton>
      )}
      {/* State is text, never colour alone (curator-ui-ux §3.4). A reason wins over the state line:
          a pause that failed must not be papered over by "playing on …". */}
      <p className="muted preview__note">
        {reason ??
          (device
            ? `Playing on ${device} — this replaced whatever Spotify was doing.`
            : "Plays a track from the album on this machine's Spotify client. The room is untouched.")}
      </p>
    </div>
  );
}

export function PreviewWorkstation({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const [mode, setMode] = useState<"bench" | "room">("bench");
  const [legs, setLegs] = useState<RehearsalLeg[] | null>(null);
  const { armed, reason } = useRoomGate();

  const colors = asset.palette?.colors ?? [];
  const holdMs = Number(asset.pattern?.params?.holdMs) || 3000;
  const hasVideo = Boolean(asset.visualizer);

  // Disarming mid-rehearsal must not leave the room running: fall back to the bench and stop.
  useEffect(() => {
    if (!armed && mode === "room") {
      setMode("bench");
      if (legs) void api.simulateScanStop(curatorId).catch(() => {});
      setLegs(null);
    }
    // `legs` deliberately omitted — this reacts to disarming, not to each rehearsal result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, mode, curatorId]);

  return (
    <div className="preview">
      <div className="modes" role="tablist" aria-label="Preview mode">
        <button
          role="tab"
          aria-selected={mode === "bench"}
          className={`modes__tab ${mode === "bench" ? "is-active" : ""}`}
          onClick={() => setMode("bench")}
        >
          Bench
          <em>Nothing leaves this window</em>
        </button>
        <button
          role="tab"
          aria-selected={mode === "room"}
          className={`modes__tab ${mode === "room" ? "is-active" : ""}`}
          onClick={() => setMode("room")}
          disabled={!armed}
          title={reason ?? undefined}
        >
          Room rehearsal
          <em>{armed ? "Drives the real room" : "Room is disarmed"}</em>
        </button>
      </div>

      {mode === "bench" ? (
        <>
          <div className="preview__stage">
            <div className="preview__sleeve">
              <Cover
                curatorId={curatorId}
                title={asset.metadata.name || curatorId}
                version={asset.artwork?.contentHash}
                state={asset.roadie.state}
              />
              <span className="preview__sleeve-cap">On the stand</span>
            </div>
            <PaletteStage colors={colors} holdMs={holdMs} />
            {hasVideo ? (
              <video
                className="preview__video"
                src={videoUrl(curatorId)}
                poster={thumbnailUrl(curatorId)}
                controls
                loop
                autoPlay
                muted
              />
            ) : (
              <div className="preview__video preview__video--empty">
                No visualizer attached yet — the sleeve and palette still show
                how the album will read.
              </div>
            )}
          </div>
          <DeskAudio
            curatorId={curatorId}
            spotifyUri={asset.metadata.spotifyUri}
          />
        </>
      ) : (
        <div className="rehearsal">
          <p className="muted">
            The real runtime path minus the physical tag: the scan event goes to
            Conductor and Backdrop exactly as the stand would send it, and Amp
            streams the album over Sonos.
          </p>
          <div className="row-actions">
            <AsyncButton
              className="btn btn--primary"
              onClick={async () =>
                setLegs((await api.simulateScan(curatorId)).services)
              }
              pendingLabel="Placing…"
            >
              Place sleeve
            </AsyncButton>
            <AsyncButton
              className="btn"
              onClick={async () => {
                setLegs((await api.simulateScanStop(curatorId)).services);
              }}
              pendingLabel="Lifting…"
            >
              Lift sleeve
            </AsyncButton>
            <Link className="btn btn--ghost" to={`/demo/${curatorId}`}>
              ▶ Full-viewport Demo Room
            </Link>
          </div>
          {legs && <LegReport legs={legs} />}
        </div>
      )}

      <div className="row-actions">
        <AsyncButton
          className="btn btn--primary"
          onClick={() => run(() => api.approvePreview(curatorId))}
          pendingLabel="Saving…"
        >
          Looks good →
        </AsyncButton>
        <AsyncButton
          className="btn"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_video"))
          }
          pendingLabel="Saving…"
        >
          Something's off — back to video
        </AsyncButton>
        <AsyncButton
          className="btn btn--ghost"
          onClick={() =>
            run(() => api.rejectPreview(curatorId, "awaiting_review"))
          }
          pendingLabel="Saving…"
        >
          Back to palette
        </AsyncButton>
      </div>
      {!armed && <p className="muted preview__note">{reason}</p>}
    </div>
  );
}
