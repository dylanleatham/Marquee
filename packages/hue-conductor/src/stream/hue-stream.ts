// The Hue Entertainment "HueStream" v2 wire format (ADR 0024). Each frame the StreamEngine produces
// is encoded into one UDP datagram sent over the DTLS session. Pure and dependency-free — the byte
// layout is the one thing about the transport we can pin down and test exhaustively off-hardware.
//
// Layout (color space RGB):
//   0..8   "HueStream"  (9 ASCII bytes)
//   9      protocol version major = 0x02
//   10     protocol version minor = 0x00
//   11     sequence id (bridge ignores it; we send 0)
//   12,13  reserved (0, 0)
//   14     color space: 0x00 = RGB, 0x01 = XY+brightness — we use RGB
//   15     reserved (0)
//   16..51 entertainment configuration id (36 ASCII bytes, the UUID)
//   then, per channel: [ channelId(1) ][ R hi,R lo ][ G hi,G lo ][ B hi,B lo ]  (7 bytes, 16-bit color)

/** One channel's color for a frame. `channel` is the entertainment channel id (0–255), not a light id. */
export interface HueStreamChannel {
  channel: number;
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

const HEADER = Buffer.from("HueStream", "ascii"); // 9 bytes
const CONFIG_ID_LEN = 36;

const clamp8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
/** Widen an 8-bit channel to the 16 bits the bridge expects: 0→0x0000, 255→0xFFFF. */
const to16 = (v: number): number => {
  const c = clamp8(v);
  return (c << 8) | c;
};

/**
 * Encode one frame into a HueStream v2 datagram. `configId` is the entertainment configuration UUID
 * (must be 36 chars). Throws on a bad config id so a misconfiguration fails loudly at send time
 * rather than the bridge silently dropping malformed packets.
 */
export function encodeHueStreamFrame(
  configId: string,
  channels: HueStreamChannel[],
): Buffer {
  if (configId.length !== CONFIG_ID_LEN) {
    throw new Error(
      `entertainment configuration id must be ${CONFIG_ID_LEN} chars, got ${configId.length}`,
    );
  }
  const buf = Buffer.alloc(16 + CONFIG_ID_LEN + channels.length * 7);
  HEADER.copy(buf, 0);
  buf[9] = 0x02; // version major
  buf[10] = 0x00; // version minor
  buf[11] = 0x00; // sequence id
  // bytes 12,13 reserved = 0 (already zeroed by alloc)
  buf[14] = 0x00; // color space: RGB
  // byte 15 reserved = 0
  buf.write(configId, 16, CONFIG_ID_LEN, "ascii");

  let off = 16 + CONFIG_ID_LEN;
  for (const c of channels) {
    buf[off] = c.channel & 0xff;
    buf.writeUInt16BE(to16(c.r), off + 1);
    buf.writeUInt16BE(to16(c.g), off + 3);
    buf.writeUInt16BE(to16(c.b), off + 5);
    off += 7;
  }
  return buf;
}
