// Generate Flipper Zero-writable NTAG213 tags for an album's `curator:album:<id>` URI (issue #67,
// "Route A"). The invariant, rigorously-tested core is the NDEF/NTAG **byte layout** — an NDEF
// well-known URI record, wrapped in the NTAG NDEF-message TLV, laid into the tag's pages — which is
// exactly the format Stylus's reader parses (`packages/stylus/stylus/ndef.py`). The `.nfc` file
// wrapper on top is a thin, isolated layer targeting a recent Flipper firmware schema; the page data
// it carries is the tested part.
import { Buffer } from "node:buffer";
import { isCuratorId } from "../ids.js";

/** The album URI written to the tag. */
export function albumUri(curatorId: string): string {
  if (!isCuratorId(curatorId))
    throw new Error(`not a curatorId: ${JSON.stringify(curatorId)}`);
  return `curator:album:${curatorId}`;
}

/**
 * Build the NTAG NDEF-message TLV for a URI: `03 <len> <ndef-message> FE`. The message is a single
 * NFC-Forum **well-known URI record** (TNF=0x01, type 'U'); because `curator:` is a custom scheme it
 * uses prefix-abbreviation code `0x00` (no prefix) + the literal URI. Short record (payload < 256),
 * which every `curator:album:<8>` URI is. This is the exact byte sequence Stylus's `parse_uri` reads.
 */
export function ndefUriTlv(uri: string): Buffer {
  const ascii = Buffer.from(uri, "ascii");
  const payload = Buffer.concat([Buffer.from([0x00]), ascii]); // 0x00 = no URI prefix
  if (payload.length > 0xff)
    throw new Error("URI too long for a short NDEF record");
  const record = Buffer.concat([
    Buffer.from([
      0xd1, // MB=1, ME=1, SR=1, TNF=0x01 (well-known)
      0x01, // type length
      payload.length, // payload length (short record)
      0x55, // type 'U' (URI)
    ]),
    payload,
  ]);
  if (record.length > 0xfe)
    throw new Error("NDEF message too long for a single-byte TLV length");
  return Buffer.concat([
    Buffer.from([0x03, record.length]), // NDEF-message TLV: type 0x03, length
    record,
    Buffer.from([0xfe]), // terminator TLV
  ]);
}

/** NTAG213 has 45 pages of 4 bytes (0–44); user memory is pages 4–39 (144 bytes). */
const NTAG213_PAGES = 45;
const USER_PAGE_START = 4;
const USER_PAGE_END = 39; // inclusive
/** Capability Container for a 144-byte NTAG213 (page 3): NDEF magic, v1.0, size, read/write. */
const NTAG213_CC = [0xe1, 0x10, 0x12, 0x00];

/**
 * Lay a URI's NDEF TLV into an NTAG213's 45 pages. Pages 0–2 are a well-formed placeholder UID (real
 * NTAG UIDs are factory-locked; a Flipper write targets the user pages), page 3 is the CC, pages 4+
 * carry the TLV zero-padded. Returns 45 rows of 4 bytes each. Throws if the TLV won't fit user memory.
 */
export function ntag213Pages(uri: string): number[][] {
  const tlv = ndefUriTlv(uri);
  const userBytes = (USER_PAGE_END - USER_PAGE_START + 1) * 4;
  if (tlv.length > userBytes)
    throw new Error(`NDEF (${tlv.length}B) exceeds NTAG213 user memory`);

  const pages: number[][] = [];
  // Placeholder UID (04 = NXP) with correct BCC0/BCC1 so the file is well-formed.
  const uid = [0x04, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60];
  const bcc0 = 0x88 ^ uid[0]! ^ uid[1]! ^ uid[2]!;
  const bcc1 = uid[3]! ^ uid[4]! ^ uid[5]! ^ uid[6]!;
  pages[0] = [uid[0]!, uid[1]!, uid[2]!, bcc0];
  pages[1] = [uid[3]!, uid[4]!, uid[5]!, uid[6]!];
  pages[2] = [bcc1, 0x48, 0x00, 0x00]; // BCC1, internal, lock bytes (unlocked)
  pages[3] = [...NTAG213_CC];

  // User memory: TLV bytes, then zero fill; config/lock pages (40–44) left at defaults (zeros).
  const user = Buffer.alloc(userBytes, 0x00);
  tlv.copy(user, 0);
  for (let p = USER_PAGE_START; p < NTAG213_PAGES; p++) {
    if (p <= USER_PAGE_END) {
      const off = (p - USER_PAGE_START) * 4;
      pages[p] = [user[off]!, user[off + 1]!, user[off + 2]!, user[off + 3]!];
    } else {
      pages[p] = [0x00, 0x00, 0x00, 0x00];
    }
  }
  return pages;
}

const hex = (b: number): string => b.toString(16).padStart(2, "0").toUpperCase();
const pageLine = (row: number[]): string => row.map(hex).join(" ");

/**
 * Render a Flipper Zero `.nfc` device file for an album's tag, ready to drop on the Flipper's SD card
 * and write to a blank NTAG213 via the stock NFC app (Saved → Write). The **page data** is the tested
 * invariant; the header schema targets recent Flipper firmware (Version 4) and is isolated here —
 * validate it once on your device (write a tag, read it back), and if your firmware wants a different
 * schema this is the one place to adjust.
 */
export function flipperNfcFile(curatorId: string): string {
  const pages = ntag213Pages(albumUri(curatorId));
  const uid = pages[0]!.slice(0, 3).concat(pages[1]!); // 7-byte UID for the header
  const header = [
    "Filetype: Flipper NFC device",
    "Version: 4",
    "Device type: NTAG213",
    `UID: ${uid.map(hex).join(" ")}`,
    "ATQA: 00 44",
    "SAK: 00",
    "Data format version: 2",
    "NTAG/Ultralight specific data:",
    `Signature: ${new Array(32).fill("00").join(" ")}`,
    "Mifare version: 00 04 04 02 01 00 0F 03",
    "Counter 0: 0",
    "Tearing 0: 00",
    "Counter 1: 0",
    "Tearing 1: 00",
    "Counter 2: 0",
    "Tearing 2: 00",
    `Pages total: ${NTAG213_PAGES}`,
    `Pages read: ${NTAG213_PAGES}`,
  ];
  const pageLines = pages.map((row, i) => `Page ${i}: ${pageLine(row)}`);
  return [...header, ...pageLines].join("\n") + "\n";
}
