import { useRoomArm, setRoomArm } from "../roomArm";

/**
 * Bench only ⇄ Room live (ADR 0028).
 *
 * It used to sit in the app-wide status bar, which is gone (ADR 0052). Its home in the new design is
 * the room's own top bar — the only screen that drives the real lights is the only screen that needs
 * to say whether it may. That also makes the posture visible at the moment it matters rather than
 * continuously, everywhere.
 *
 * A plain toggle, no confirm dialog: the switch *is* the deliberate act.
 */
export function RoomArmSwitch() {
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
          ? "The room is live — this will drive the real lights, display and Sonos. Click for bench only."
          : "Bench only — nothing here will touch the room. Click to put it in the room."
      }
    >
      {/* Never colour alone (curator-ui-ux §3.4): the dot always carries its word. */}
      <span aria-hidden="true" className="room-arm__dot" />
      {live ? "In the room" : "Bench only"}
    </button>
  );
}
