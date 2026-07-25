import { api } from "../api";
import { STATE_LABEL } from "../format";
import { usePoll } from "../hooks";
import { Spinner } from "./common";
import { useRoomArm, setRoomArm } from "../roomArm";

/**
 * The room-arm switch (ADR 0028). Lives in the status bar because it is a session-level posture, not
 * a per-action decision: you set it once when you sit down. While live it says so continuously, so
 * "the room is under my control right now" is never something you have to remember.
 */
function RoomArmSwitch() {
  const arm = useRoomArm();
  const live = arm === "live";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={live}
      className={`room-arm ${live ? "room-arm--live" : "room-arm--bench"}`}
      onClick={() => setRoomArm(live ? "bench" : "live")}
      title={
        live
          ? "The room is armed — rehearsals will drive the real lights, display and Sonos. Click to go back to bench-only."
          : "Bench only — nothing in Curator will touch the room. Click to arm it."
      }
    >
      {/* Never colour alone (curator-ui-ux §3.4): the dot always carries its word. */}
      <span aria-hidden="true" className="room-arm__dot" />
      {live ? "Room live" : "Bench only"}
    </button>
  );
}

/** Persistent bottom strip: what Roadie is doing right now + pause/resume (curator-spec §10). */
export function RoadieStrip() {
  const { data: status, refresh } = usePoll(api.status, 2000);

  const toggle = async () => {
    if (!status) return;
    await (status.paused ? api.resume() : api.pause());
    refresh();
  };

  const summary = !status ? (
    <>
      <Spinner /> connecting to Roadie…
    </>
  ) : status.paused ? (
    "Roadie: paused"
  ) : status.current ? (
    <>
      Roadie: working on <code>{status.current}</code>
      {status.activity[0] ? ` (${STATE_LABEL[status.activity[0].to]})` : ""}
    </>
  ) : status.queueDepth > 0 ? (
    `Roadie: ${status.queueDepth} queued`
  ) : (
    "Roadie: idle, queue empty"
  );

  return (
    <footer className="roadie-strip">
      <span className="roadie-strip__summary">{summary}</span>
      {status && (
        <button className="btn btn--ghost btn--sm" onClick={toggle}>
          {status.paused ? "Resume" : "Pause"}
        </button>
      )}
      <RoomArmSwitch />
    </footer>
  );
}
