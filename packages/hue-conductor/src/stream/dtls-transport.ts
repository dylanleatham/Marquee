// The real `StreamTransport` (ADR 0024): encode each frame as a HueStream v2 datagram and push it
// over a DTLS/UDP socket to the bridge. The encoding + framing is unit-tested via an injected socket;
// the actual DTLS handshake (`createHueDtlsSocket`) is the one part that can only be verified on
// hardware, so it's kept to a thin, clearly-marked wrapper around node-dtls-client.
import { dtls } from "node-dtls-client";
import { encodeHueStreamFrame } from "./hue-stream.js";
import type { StreamFrame } from "./types.js";
import type { StreamTransport } from "./engine.js";

/** The minimal UDP-ish socket the transport needs. Injected so `send`/`close` are testable. */
export interface DtlsSocket {
  send(data: Buffer): void;
  close(): void;
}

/**
 * Streams frames to an entertainment area over a connected `DtlsSocket`. Each `StreamFrame` light's
 * `id` is the entertainment channel id (a number as string — populated from the area's channels);
 * lights whose id isn't numeric are skipped rather than corrupting the packet.
 */
export class DtlsStreamTransport implements StreamTransport {
  private closed = false;

  constructor(
    private readonly socket: DtlsSocket,
    private readonly configId: string,
  ) {}

  send(frame: StreamFrame): void {
    if (this.closed) return;
    const channels = [];
    for (const c of frame) {
      const channel = Number(c.id);
      if (!Number.isInteger(channel)) continue;
      channels.push({ channel, r: c.r, g: c.g, b: c.b });
    }
    this.socket.send(encodeHueStreamFrame(this.configId, channels));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

/** The only suite the Hue Entertainment API accepts (Hue Entertainment API docs, §DTLS). */
const HUE_DTLS_CIPHER = "TLS_PSK_WITH_AES_128_GCM_SHA256";

export interface HueDtlsParams {
  ip: string;
  applicationKey: string;
  /** DTLS pre-shared key, hex (the bridge `clientkey` captured at pairing). */
  clientkey: string;
  /** UDP port for the Entertainment stream. The bridge always uses 2100. */
  port?: number;
  /** Handshake timeout. */
  timeoutMs?: number;
}

/**
 * Open a DTLS session to the bridge's Entertainment port and resolve a `DtlsSocket` once the PSK
 * handshake completes. **Hardware-verified only** — off a real bridge there's nothing to handshake
 * with, so this wrapper stays deliberately thin (the testable logic lives in `DtlsStreamTransport`
 * and `encodeHueStreamFrame`). PSK identity is the application key; the key is the hex `clientkey`.
 */
export function createHueDtlsSocket(
  params: HueDtlsParams,
): Promise<DtlsSocket> {
  return new Promise<DtlsSocket>((resolve, reject) => {
    const socket = dtls.createSocket({
      type: "udp4",
      address: params.ip,
      port: params.port ?? 2100,
      // Pinned to the one suite the Entertainment API speaks. With node-dtls-client's default list
      // the bridge never answers: every handshake timed out and every streaming effect fell back
      // to CLIP, so a record set to wave played rotate (issue #360). Pinned, it connects in ~40ms.
      ciphers: [HUE_DTLS_CIPHER],
      psk: { [params.applicationKey]: Buffer.from(params.clientkey, "hex") },
      timeout: params.timeoutMs ?? 5000,
    });
    let settled = false;
    socket.on("connected", () => {
      settled = true;
      resolve({
        send: (data) => socket.send(data),
        close: () => socket.close(),
      });
    });
    socket.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
