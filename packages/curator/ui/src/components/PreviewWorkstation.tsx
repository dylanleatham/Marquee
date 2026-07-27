// The Preview workstation (ADR 0028 / curator-ui-ux §6). Two modes, and the split is a safety
// property, not a style: the listening room may have other people in it, so taking over their lights
// and starting music is a side effect on humans.
//
//  - Bench  — everything in the window. Touches no hardware, ever. The default, always available.
//  - Room   — the real runtime path minus the physical tag, behind the room-arm switch.
import { useEffect, useState } from "react";
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
          {/* Audio is the one unresolved piece (curator-ui-ux §11): bench ships silent until the
              Spotify desk-playback route is proven by a spike. Say so rather than hide it. */}
          <p className="muted preview__note">
            Bench preview is silent for now — desk audio is pending a spike on
            the Spotify playback route.
          </p>
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
