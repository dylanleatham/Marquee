import type { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DtlsStreamTransport,
  createHueDtlsSocket,
} from "../src/stream/dtls-transport.js";
import { encodeHueStreamFrame } from "../src/stream/hue-stream.js";
import type { DtlsSocket } from "../src/stream/dtls-transport.js";

/**
 * The options `createHueDtlsSocket` hands node-dtls-client, and the socket it gets back — the library
 * is replaced so the handshake's *inputs* are testable off the bridge (issue #360).
 */
const dtlsCalls = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  sockets: [] as Array<EventEmitter & Record<string, unknown>>,
}));
vi.mock("node-dtls-client", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    dtls: {
      createSocket: (options: Record<string, unknown>) => {
        dtlsCalls.options.push(options);
        const socket = Object.assign(new Emitter(), {
          send: vi.fn(),
          close: vi.fn(),
        });
        dtlsCalls.sockets.push(socket);
        return socket;
      },
    },
  };
});

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

describe("createHueDtlsSocket (issue #360)", () => {
  const params = {
    ip: "192.168.1.2",
    applicationKey: "app-key",
    clientkey: "00112233445566778899aabbccddeeff",
  };

  beforeEach(() => {
    dtlsCalls.options.length = 0;
    dtlsCalls.sockets.length = 0;
  });

  it("offers the bridge only the one suite it speaks", () => {
    // With node-dtls-client's default list the bridge never answers, and the handshake times out on
    // every scan — so every streaming effect fell back to CLIP and wave played as rotate. Pinned, the
    // same bridge connects in ~40ms (probed on the Pi, 2026-09-27).
    void createHueDtlsSocket(params);
    expect(dtlsCalls.options[0]?.ciphers).toEqual([
      "TLS_PSK_WITH_AES_128_GCM_SHA256",
    ]);
  });

  it("identifies with the application key and keys with the hex clientkey, on port 2100", () => {
    void createHueDtlsSocket(params);
    const opts = dtlsCalls.options[0]!;
    expect(opts.address).toBe("192.168.1.2");
    expect(opts.port).toBe(2100);
    expect(opts.psk).toEqual({
      "app-key": Buffer.from(params.clientkey, "hex"),
    });
  });

  it("resolves once connected, and the socket it returns sends through the DTLS socket", async () => {
    const pending = createHueDtlsSocket(params);
    const raw = dtlsCalls.sockets[0]!;
    raw.emit("connected");
    const socket = await pending;
    socket.send(Buffer.from([1]));
    expect(raw.send).toHaveBeenCalledWith(Buffer.from([1]));
  });

  it("rejects when the handshake fails, so the caller can fall back", async () => {
    const pending = createHueDtlsSocket(params);
    dtlsCalls.sockets[0]!.emit(
      "error",
      new Error("The DTLS handshake timed out"),
    );
    await expect(pending).rejects.toThrow("The DTLS handshake timed out");
  });
});
