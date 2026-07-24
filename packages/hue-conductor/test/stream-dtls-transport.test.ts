import { describe, it, expect } from "vitest";
import { DtlsStreamTransport } from "../src/stream/dtls-transport.js";
import { encodeHueStreamFrame } from "../src/stream/hue-stream.js";
import type { DtlsSocket } from "../src/stream/dtls-transport.js";

const CONFIG_ID = "12345678-1234-1234-1234-1234567890ab";

function fakeSocket() {
  const sent: Buffer[] = [];
  let closed = false;
  const socket: DtlsSocket = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
    },
  };
  return { socket, sent, isClosed: () => closed };
}

describe("DtlsStreamTransport", () => {
  it("encodes each frame as a HueStream datagram keyed by channel id", () => {
    const f = fakeSocket();
    const transport = new DtlsStreamTransport(f.socket, CONFIG_ID);
    transport.send([
      { id: "0", r: 255, g: 0, b: 0 },
      { id: "1", r: 0, g: 255, b: 0 },
    ]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toEqual(
      encodeHueStreamFrame(CONFIG_ID, [
        { channel: 0, r: 255, g: 0, b: 0 },
        { channel: 1, r: 0, g: 255, b: 0 },
      ]),
    );
  });

  it("skips lights whose id isn't a channel number", () => {
    const f = fakeSocket();
    new DtlsStreamTransport(f.socket, CONFIG_ID).send([
      { id: "left", r: 1, g: 2, b: 3 },
      { id: "2", r: 4, g: 5, b: 6 },
    ]);
    expect(f.sent[0]).toEqual(
      encodeHueStreamFrame(CONFIG_ID, [{ channel: 2, r: 4, g: 5, b: 6 }]),
    );
  });

  it("close() closes the socket and stops sending", () => {
    const f = fakeSocket();
    const transport = new DtlsStreamTransport(f.socket, CONFIG_ID);
    transport.close();
    expect(f.isClosed()).toBe(true);
    transport.send([{ id: "0", r: 1, g: 1, b: 1 }]);
    expect(f.sent).toHaveLength(0); // no frames after close
  });
});
