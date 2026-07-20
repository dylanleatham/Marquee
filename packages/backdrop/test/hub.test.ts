import { describe, it, expect, vi } from "vitest";
import { SocketHub, type Socket } from "../src/hub.js";
import type { BrowserEvent } from "../src/types.js";

/** A stub ws socket that records what it was sent. `readyState` defaults to OPEN (1). */
function stubSocket(readyState = 1): Socket & { sent: string[] } {
  return {
    sent: [],
    readyState,
    send(data: string) {
      this.sent.push(data);
    },
  };
}

describe("SocketHub", () => {
  it("broadcasts a command to every connected socket as JSON", () => {
    const hub = new SocketHub();
    const a = stubSocket();
    const b = stubSocket();
    hub.add(a);
    hub.add(b);

    hub.broadcast({ type: "play", filePath: "/m/x.mp4" });

    expect(a.sent).toEqual(['{"type":"play","filePath":"/m/x.mp4"}']);
    expect(b.sent).toEqual(['{"type":"play","filePath":"/m/x.mp4"}']);
    expect(hub.connectedCount()).toBe(2);
  });

  it("stops delivering to a removed socket", () => {
    const hub = new SocketHub();
    const a = stubSocket();
    const b = stubSocket();
    hub.add(a);
    hub.add(b);
    hub.remove(a);

    hub.broadcast({ type: "stop" });

    expect(a.sent).toEqual([]); // evicted
    expect(b.sent).toEqual(['{"type":"stop"}']);
    expect(hub.connectedCount()).toBe(1);
  });

  it("skips a socket that isn't OPEN", () => {
    const hub = new SocketHub();
    const closing = stubSocket(2); // CLOSING
    hub.add(closing);
    hub.broadcast({ type: "stop" });
    expect(closing.sent).toEqual([]);
  });

  it("a throwing socket doesn't block delivery to the others", () => {
    const hub = new SocketHub();
    const bad: Socket = {
      readyState: 1,
      send() {
        throw new Error("dead pipe");
      },
    };
    const good = stubSocket();
    hub.add(bad);
    hub.add(good);

    expect(() => hub.broadcast({ type: "stop" })).not.toThrow();
    expect(good.sent).toEqual(['{"type":"stop"}']);
  });

  it("parses an inbound browser event and forwards it to onEvent", () => {
    const onEvent = vi.fn();
    const hub = new SocketHub(onEvent);
    const ev: BrowserEvent = { type: "playback-started", filePath: "/m/x.mp4" };
    hub.receive(JSON.stringify(ev));
    expect(onEvent).toHaveBeenCalledWith(ev);
  });

  it("ignores a malformed inbound frame without throwing", () => {
    const onEvent = vi.fn();
    const hub = new SocketHub(onEvent);
    expect(() => hub.receive("{not json")).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
