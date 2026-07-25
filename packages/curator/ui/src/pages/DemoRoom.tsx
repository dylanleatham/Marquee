// The Demo Room (runtime preview): play an album's visualizer fullscreen with Backdrop-accurate
// idle→play→crossfade transitions, and drive the *real* Hue lights through Conductor as you "place"
// and "lift" the sleeve. No Pi required — the video is local and Conductor runs on the workstation.
// See runtime-overview §6 (the "preview, no hardware" step) and ADR 0007.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  videoUrl,
  type AlbumAsset,
  type AlbumSummary,
  type DemoRoomInfo,
  type DemoStatus,
} from "../api";
import { useRoomGate } from "../roomArm";

type Phase = "idle" | "playing";

export function DemoRoom() {
  const { curatorId = "" } = useParams();
  const navigate = useNavigate();
  // The Demo Room is the full-viewport presentation of Preview's room mode (ADR 0028), so it obeys
  // the same arm switch. Bench-only means nothing here reaches the lights.
  const { armed, reason: armReason } = useRoomGate();

  const [currentId, setCurrentId] = useState(curatorId);
  const [album, setAlbum] = useState<AlbumAsset | null>(null);
  const [videoAlbums, setVideoAlbums] = useState<AlbumSummary[]>([]);
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [rooms, setRooms] = useState<DemoRoomInfo[]>([]);
  const [lightsError, setLightsError] = useState<string | null>(null);

  // Two stacked video layers so a swap crossfades (new preloads underneath, then we flip opacity).
  const [phase, setPhase] = useState<Phase>("idle");
  const [active, setActive] = useState<0 | 1>(0);
  const [layerSrc, setLayerSrc] = useState<[string | null, string | null]>([
    null,
    null,
  ]);
  const videoRefs = [
    useRef<HTMLVideoElement>(null),
    useRef<HTMLVideoElement>(null),
  ];

  const refreshStatus = useCallback(
    () =>
      api
        .demoStatus()
        .then(setStatus)
        .catch(() =>
          setStatus({ reachable: false, paired: false, listeningRoomId: null }),
        ),
    [],
  );

  // Load the album being demoed (for its title + whether it has a video).
  useEffect(() => {
    let live = true;
    api
      .album(currentId)
      .then((a) => live && setAlbum(a))
      .catch(() => live && setAlbum(null));
    return () => {
      live = false;
    };
  }, [currentId]);

  // One-time: the swap list (albums with a video) and Conductor status.
  useEffect(() => {
    api
      .albums()
      .then((r) => setVideoAlbums(r.albums.filter((a) => a.hasVideo)))
      .catch(() => {});
    refreshStatus();
  }, [refreshStatus]);

  // If Conductor is reachable but no listening room is chosen, load the room options for the picker.
  useEffect(() => {
    if (status?.reachable && !status.listeningRoomId)
      api
        .demoRooms()
        .then((r) => setRooms(r.rooms))
        .catch(() => {});
  }, [status?.reachable, status?.listeningRoomId]);

  // Route the lights through Conductor; a failure (offline, no room, not ready) is shown but never
  // blocks the video — the demo degrades to "video only".
  const runLights = async (fn: () => Promise<unknown>) => {
    setLightsError(null);
    try {
      await fn();
    } catch (err) {
      setLightsError(err instanceof Error ? err.message : String(err));
    }
  };

  // Bring a video up on the inactive layer, then flip to it (CSS crossfades the opacity).
  const showVideo = (id: string) => {
    const next = (active ^ 1) as 0 | 1;
    setLayerSrc((prev) => {
      const copy: [string | null, string | null] = [prev[0], prev[1]];
      copy[next] = id;
      return copy;
    });
    setActive(next);
    setPhase("playing");
    // Restart the incoming layer from the top so a re-shown album doesn't resume mid-loop.
    const el = videoRefs[next]?.current;
    if (el) {
      el.currentTime = 0;
      // play() may reject (autoplay policy) or be a no-op stub under jsdom — guard both.
      const p = el.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  };

  const placeSleeve = async () => {
    if (album?.visualizer) showVideo(currentId);
    else setPhase("playing"); // lights-only album: no video, but still wash the room
    await runLights(() => api.demoPlay(currentId));
  };

  const liftSleeve = async () => {
    setPhase("idle");
    await runLights(() => api.demoStop());
  };

  const swapTo = async (id: string) => {
    setCurrentId(id);
    setLightsError(null);
    // Optimistically show the new video; album state follows from the effect.
    showVideo(id);
    await runLights(() => api.demoPlay(id));
  };

  const chooseRoom = async (roomId: string) => {
    await runLights(() => api.demoSetRoom(roomId));
    await refreshStatus();
  };

  const idx = videoAlbums.findIndex((a) => a.curatorId === currentId);
  const step = (delta: number) => {
    if (videoAlbums.length < 2) return;
    const n =
      videoAlbums[(idx + delta + videoAlbums.length) % videoAlbums.length];
    if (n) void swapTo(n.curatorId);
  };

  const roomName = (id: string | null) =>
    rooms.find((r) => r.id === id)?.name ?? id ?? "";

  const lightsBadge = () => {
    if (!status) return "Lights: …";
    if (!status.reachable) return "Lights: Conductor offline";
    if (!status.listeningRoomId) return "Lights: pick a room ↓";
    return `Lights: ${roomName(status.listeningRoomId)}`;
  };

  const needsRoom = Boolean(status?.reachable && !status.listeningRoomId);

  return (
    <div className={`demo demo--${phase}`}>
      <header className="demo__bar demo__bar--top">
        <button
          className="btn btn--ghost"
          onClick={() => navigate(`/albums/${curatorId}`)}
        >
          ← Back
        </button>
        <div className="demo__title">
          {album ? (
            <>
              <strong>{album.metadata.name}</strong>
              <span className="muted"> — {album.metadata.artist}</span>
            </>
          ) : (
            <span className="muted">Loading…</span>
          )}
        </div>
        <span
          className={`demo__lights ${status && !status.reachable ? "demo__lights--off" : ""}`}
        >
          {lightsBadge()}
        </span>
      </header>

      {needsRoom && (
        <div className="demo__roompick">
          <span>Which room are your lights in?</span>
          <select
            className="select"
            defaultValue=""
            onChange={(e) => e.target.value && chooseRoom(e.target.value)}
          >
            <option value="" disabled>
              Choose a room…
            </option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.lightIds.length} lights)
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="demo__stage">
        {[0, 1].map((i) =>
          layerSrc[i] ? (
            <video
              key={i}
              ref={videoRefs[i]}
              className="demo__video"
              src={videoUrl(layerSrc[i]!)}
              style={{ opacity: phase === "playing" && active === i ? 1 : 0 }}
              muted
              loop
              autoPlay
              playsInline
            />
          ) : null,
        )}
        <div
          className="demo__idle"
          style={{ opacity: phase === "idle" ? 1 : 0 }}
          aria-hidden={phase !== "idle"}
        >
          <div className="demo__idle-hint">
            {album?.visualizer
              ? "Place the sleeve on the stand to begin"
              : "No video attached — the lights will still play"}
          </div>
        </div>
        {lightsError && (
          <div className="demo__lights-error">Lights: {lightsError}</div>
        )}
      </div>

      <footer className="demo__bar demo__bar--bottom">
        {videoAlbums.length > 1 && (
          <button
            className="btn btn--ghost"
            onClick={() => step(-1)}
            aria-label="previous album"
          >
            ◀
          </button>
        )}
        {/* The Demo Room drives the real lights, and is reachable by direct URL — so the arm gate
            lives here, not only on the link that got you here (ADR 0028). Disabled, never hidden:
            the reason is shown rather than the control vanishing (curator-ui-ux §4). */}
        {phase === "idle" ? (
          <button
            className="btn btn--primary btn--lg"
            onClick={placeSleeve}
            disabled={!armed}
            title={armReason ?? undefined}
          >
            Place sleeve ▸
          </button>
        ) : (
          <button className="btn btn--lg" onClick={liftSleeve}>
            Lift sleeve
          </button>
        )}
        {videoAlbums.length > 1 && (
          <button
            className="btn btn--ghost"
            onClick={() => step(1)}
            aria-label="next album"
          >
            ▶
          </button>
        )}
      </footer>
    </div>
  );
}
