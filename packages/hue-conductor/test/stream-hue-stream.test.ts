import { describe, it, expect } from "vitest";
import { encodeHueStreamFrame } from "../src/stream/hue-stream.js";

const CONFIG_ID = "12345678-1234-1234-1234-1234567890ab"; // 36 chars

describe("encodeHueStreamFrame", () => {
  it("writes the HueStream v2 header and config id", () => {
    const buf = encodeHueStreamFrame(CONFIG_ID, []);
    expect(buf.subarray(0, 9).toString("ascii")).toBe("HueStream");
    expect(buf[9]).toBe(0x02); // version major
    expect(buf[10]).toBe(0x00); // version minor
    expect(buf[14]).toBe(0x00); // color space RGB
    expect(buf.subarray(16, 52).toString("ascii")).toBe(CONFIG_ID);
    expect(buf).toHaveLength(16 + 36); // no channels
  });

  it("appends 7 bytes per channel: id + 16-bit R,G,B", () => {
    const buf = encodeHueStreamFrame(CONFIG_ID, [
      { channel: 3, r: 255, g: 0, b: 128 },
    ]);
    expect(buf).toHaveLength(16 + 36 + 7);
    const off = 52;
    expect(buf[off]).toBe(3); // channel id
    expect(buf.readUInt16BE(off + 1)).toBe(0xffff); // 255 → full 16-bit
    expect(buf.readUInt16BE(off + 3)).toBe(0x0000); // 0 → 0
    expect(buf.readUInt16BE(off + 5)).toBe(0x8080); // 128 → (128<<8)|128
  });

  it("packs multiple channels in order", () => {
    const buf = encodeHueStreamFrame(CONFIG_ID, [
      { channel: 0, r: 1, g: 2, b: 3 },
      { channel: 7, r: 4, g: 5, b: 6 },
    ]);
    expect(buf).toHaveLength(16 + 36 + 14);
    expect(buf[52]).toBe(0); // first channel id
    expect(buf[59]).toBe(7); // second channel id (52 + 7)
  });

  it("clamps out-of-range values", () => {
    const buf = encodeHueStreamFrame(CONFIG_ID, [
      { channel: 300, r: 999, g: -5, b: 255 },
    ]);
    expect(buf[52]).toBe(300 & 0xff); // channel wraps to a byte
    expect(buf.readUInt16BE(53)).toBe(0xffff); // 999 clamps to 255→0xFFFF
    expect(buf.readUInt16BE(55)).toBe(0x0000); // -5 clamps to 0
  });

  it("rejects a config id that isn't 36 chars", () => {
    expect(() => encodeHueStreamFrame("too-short", [])).toThrow(/36 chars/);
  });
});
