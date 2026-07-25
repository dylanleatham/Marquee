// Settings: the listening room, and whether the sibling services are actually reachable (issue #101).
//
// The listening room was previously settable *only* from the Demo Room's first-run picker — so once
// set, there was no way to change it short of editing Conductor's settings by hand. curator-spec §10
// calls it "the setting most likely to change", which made that the sharpest gap in Settings.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type DemoRoomInfo, type ServiceHealth } from "../api";
import { AsyncButton, Spinner } from "./common";

const SERVICE_LABEL: Record<ServiceHealth["service"], string> = {
  conductor: "Hue Conductor — lights",
  backdrop: "Backdrop — display",
  amp: "Amp — Sonos audio",
};

function HealthRow({ health }: { health: ServiceHealth }) {
  // Three distinct outcomes, not two: never set up, set up but unreachable, working. Colour is
  // never the only channel (curator-ui-ux §3.4), so each carries its own word.
  const tone = !health.configured ? "off" : health.reachable ? "ok" : "bad";
  const word = !health.configured
    ? "Not configured"
    : health.reachable
      ? "Reachable"
      : "Unreachable";
  return (
    <li className={`legs__item legs__item--${tone === "ok" ? "ok" : "off"}`}>
      <span aria-hidden="true" className="legs__dot" />
      <b>{SERVICE_LABEL[health.service]}</b> {word}
      {health.url && <code className="health__url">{health.url}</code>}
      {health.detail && <em> — {health.detail}</em>}
    </li>
  );
}

export function RoomAndServices() {
  const [rooms, setRooms] = useState<DemoRoomInfo[] | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [conductorDown, setConductorDown] = useState(false);
  const [health, setHealth] = useState<ServiceHealth[] | null>(null);

  const loadRoom = useCallback(async () => {
    try {
      const status = await api.demoStatus();
      setConductorDown(!status.reachable);
      setRoomId(status.listeningRoomId);
      if (status.reachable) setRooms((await api.demoRooms()).rooms);
    } catch (err) {
      setConductorDown(true);
      setRoomError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadRoom();
  }, [loadRoom]);

  /**
   * curator-spec §10: "if the push fails, the setting change is rolled back and the user sees a
   * clear error." The select is optimistic so it feels immediate, but a rejected push puts the old
   * value back — a dropdown left showing a room that didn't save is worse than a slow one.
   */
  const chooseRoom = async (next: string) => {
    const previous = roomId;
    setRoomId(next);
    setRoomError(null);
    try {
      await api.demoSetRoom(next);
      await loadRoom();
    } catch (err) {
      setRoomId(previous);
      setRoomError(
        `Couldn't set the listening room: ${
          err instanceof ApiError ? err.message : String(err)
        }`,
      );
    }
  };

  return (
    <>
      <h2>Listening room</h2>
      <p className="muted">
        The Hue room Conductor drives when a sleeve is scanned. Changing it
        takes effect immediately — Conductor stores it, so the runtime keeps
        using it whether or not Curator is running.
      </p>
      {conductorDown ? (
        <div className="banner banner--warn">
          Conductor isn't reachable, so the room list can't be loaded. It's
          configured but down, or not started yet — see Services below.
        </div>
      ) : rooms === null ? (
        <p className="muted">
          <Spinner /> Loading rooms…
        </p>
      ) : rooms.length === 0 ? (
        <div className="banner banner--warn">
          Conductor is reachable but reports no rooms. Pair the Hue bridge and
          set up at least one room in the Hue app.
        </div>
      ) : (
        <select
          className="select"
          aria-label="listening room"
          value={roomId ?? ""}
          onChange={(e) => void chooseRoom(e.target.value)}
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
      )}
      {roomError && <div className="banner banner--error">{roomError}</div>}

      <h2>Services</h2>
      <p className="muted">
        Where Curator sends scans and playback. URLs and shared secrets live in{" "}
        <code>config.toml</code> (or env) rather than here — they change rarely,
        and a web form is the wrong home for a shared secret. What's useful in
        the app is knowing whether they answer.
      </p>
      <div className="row-actions">
        <AsyncButton
          className="btn"
          onClick={async () => setHealth((await api.serviceHealth()).services)}
          pendingLabel="Testing…"
        >
          Test connections
        </AsyncButton>
      </div>
      {health && (
        <ul className="legs">
          {health.map((h) => (
            <HealthRow key={h.service} health={h} />
          ))}
        </ul>
      )}
    </>
  );
}
