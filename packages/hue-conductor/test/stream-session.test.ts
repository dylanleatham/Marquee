import { describe, it, expect, vi } from "vitest";
import { StreamSession } from "../src/stream/session.js";
import type { StreamTimers } from "../src/stream/engine.js";
import type { DtlsSocket } from "../src/stream/dtls-transport.js";
import type { EntertainmentArea } from "../src/stream/clip2.js";
import type { RoomSnapshot } from "../src/bridge/adapter.js";

const AREA_ID = "12345678-1234-1234-1234-1234567890ab"; // entertainment ids are 36-char UUIDs
const AREA: EntertainmentArea = {
  id: AREA_ID,
  name: "Listening Room",
  channels: [
    { channel: 0, x: -1, y: 0, z: 0 },
    { channel: 1, x: 1, y: 0, z: 0 },
  ],
};
const SNAP: RoomSnapshot = { lights: { "11": { on: true, bri: 200 } } };

// Timers that capture the interval callback so we can prove frames flow, and the idle timer.
function fakeTimers() {
  const cbs: Array<() => void> = [];
  const timers: StreamTimers = {
    set: (fn) => {
      cbs.push(fn);
      return cbs.length - 1;
    },
    clear: () => {},
  };
  return { timers, cbs };
}

function harness() {
  const calls: string[] = [];
  const rooms = {
    snapshotRoom: vi.fn(async () => {
      calls.push("snapshot");
      return SNAP;
    }),
    restoreRoom: vi.fn(async () => {
      calls.push("restore");
    }),
  };
  const control = {
    listEntertainmentAreas: vi.fn(async () => {
      calls.push("list");
      return [AREA];
    }),
    setStreaming: vi.fn(async (_id: string, on: boolean) => {
      calls.push(on ? "stream-start" : "stream-stop");
    }),
  };
  const sent: Buffer[] = [];
  const socket: DtlsSocket = {
    send: (d) => sent.push(d),
    close: () => calls.push("socket-close"),
  };
  const connect = vi.fn(async () => {
    calls.push("connect");
    return socket;
  });
  return { calls, rooms, control, connect, sent };
}

describe("StreamSession", () => {
  it("start orchestrates snapshot → stream-on → connect, then streams frames", async () => {
    const h = harness();
    const t = fakeTimers();
    const session = new StreamSession(h.rooms, h.control, h.connect, {
      timers: t.timers,
      now: () => 0,
      fps: 25,
    });

    await session.start("room-1", AREA_ID, "wave", ["#FF0000", "#00FF00"]);

    expect(h.calls).toEqual(["list", "snapshot", "stream-start", "connect"]);
    expect(session.isStreaming()).toBe(true);
    // Engine emitted the immediate frame → one datagram already sent over the socket.
    expect(h.sent.length).toBeGreaterThanOrEqual(1);
    // Ticking the engine's interval sends more.
    t.cbs[0]!(); // interval callback
    expect(h.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("stop halts streaming, leaves streaming mode, and restores the room", async () => {
    const h = harness();
    const t = fakeTimers();
    const session = new StreamSession(h.rooms, h.control, h.connect, {
      timers: t.timers,
      now: () => 0,
    });
    await session.start("room-1", AREA_ID, "aurora", ["#112233"]);
    h.calls.length = 0;

    await session.stop();

    expect(session.isStreaming()).toBe(false);
    expect(h.calls).toEqual(["socket-close", "stream-stop", "restore"]);
  });

  it("throws (and doesn't enter streaming mode) when the area is unknown", async () => {
    const h = harness();
    const session = new StreamSession(h.rooms, h.control, h.connect, {
      timers: fakeTimers().timers,
    });
    await expect(
      session.start("room-1", "missing", "wave", ["#FFFFFF"]),
    ).rejects.toThrow(/not found/);
    expect(h.control.setStreaming).not.toHaveBeenCalled();
    expect(session.isStreaming()).toBe(false);
  });

  it("rolls back streaming mode and restores if the DTLS handshake fails", async () => {
    const h = harness();
    const connect = vi.fn(async () => {
      throw new Error("handshake timeout");
    });
    const session = new StreamSession(h.rooms, h.control, connect, {
      timers: fakeTimers().timers,
    });
    await expect(
      session.start("room-1", AREA_ID, "wave", ["#FFFFFF", "#000000"]),
    ).rejects.toThrow(/handshake/);
    // entered streaming mode, then backed it out + restored the room
    expect(h.control.setStreaming).toHaveBeenNthCalledWith(1, AREA_ID, true);
    expect(h.control.setStreaming).toHaveBeenNthCalledWith(2, AREA_ID, false);
    expect(h.rooms.restoreRoom).toHaveBeenCalled();
    expect(session.isStreaming()).toBe(false);
  });
});
