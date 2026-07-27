import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  albumUri,
  tagUri,
  ndefUriTlv,
  ntag213Pages,
  flipperNfcFile,
} from "../src/tags/flipper-nfc.js";
import { buildServer } from "../src/server.js";
import { AssetStore } from "../src/store/asset-store.js";
import { fakeRoadie, makeAsset } from "./helpers.js";

const ID = "2k7bxq9m";
const URI = `curator:album:${ID}`;

/** Decode a URI back out of an NTAG NDEF-message TLV — mirrors Stylus's `parse_uri` (ndef.py). */
function decodeUri(tlv: Buffer): string | null {
  let i = 0;
  // Unwrap TLVs to find the NDEF-message TLV (type 0x03).
  let msg: Buffer | null = null;
  while (i < tlv.length) {
    const t = tlv[i++]!;
    if (t === 0x00) continue; // NULL TLV
    if (t === 0xfe) break; // terminator
    const len = tlv[i++]!;
    if (t === 0x03) {
      msg = tlv.subarray(i, i + len);
      break;
    }
    i += len;
  }
  if (!msg) return null;
  // Parse the first well-known URI record: [header, typeLen, payloadLen, type…, payload…].
  const header = msg[0]!;
  const typeLen = msg[1]!;
  const payloadLen = msg[2]!; // short record
  const type = msg.subarray(3, 3 + typeLen).toString("ascii");
  const payload = msg.subarray(3 + typeLen, 3 + typeLen + payloadLen);
  if ((header & 0x07) !== 0x01 || type !== "U") return null;
  return payload.subarray(1).toString("utf8"); // drop the prefix byte
}

describe("albumUri", () => {
  it("formats and validates the curatorId", () => {
    expect(albumUri(ID)).toBe(URI);
    expect(() => albumUri("BAD")).toThrow();
    expect(() => albumUri("../etc")).toThrow();
  });
});

describe("tagUri — sleeve vs card (ADR 0034)", () => {
  it("builds the right URI per physical object", () => {
    expect(tagUri(ID)).toBe(`curator:album:${ID}`); // default = sleeve
    expect(tagUri(ID, "sleeve")).toBe(`curator:album:${ID}`);
    expect(tagUri(ID, "card")).toBe(`curator:card:${ID}`);
  });
  it("validates the curatorId for either object", () => {
    expect(() => tagUri("BAD", "card")).toThrow();
    expect(() => tagUri("../etc")).toThrow();
  });
  it("a card tag's pages round-trip back to the curator:card URI", () => {
    const pages = ntag213Pages(tagUri(ID, "card"));
    const user = Buffer.from(pages.slice(4, 40).flat());
    expect(decodeUri(user)).toBe(`curator:card:${ID}`);
  });
});

describe("ndefUriTlv — the byte contract Stylus reads", () => {
  it("produces the exact well-known URI record TLV", () => {
    const hex = ndefUriTlv(URI).toString("hex").toUpperCase();
    // 03 1B | D1 01 17 55 00 | "curator:album:2k7bxq9m" (ascii) | FE
    expect(hex).toBe(
      "031BD10117550063757261746F723A616C62756D3A326B37627871396DFE",
    );
  });

  it("round-trips back to the URI (same decode Stylus does)", () => {
    expect(decodeUri(ndefUriTlv(URI))).toBe(URI);
  });

  it("uses prefix code 0x00 (custom scheme, no abbreviation)", () => {
    const tlv = ndefUriTlv(URI);
    // message starts at offset 2; payload byte after [D1,01,len,55] is the prefix code.
    expect(tlv[6]).toBe(0x00);
  });

  it("rejects a URI too long for a short NDEF record", () => {
    expect(() => ndefUriTlv("x".repeat(300))).toThrow(/short NDEF record/);
  });
});

describe("ntag213Pages", () => {
  const pages = ntag213Pages(URI);

  it("has 45 pages with the NTAG213 CC on page 3", () => {
    expect(pages).toHaveLength(45);
    expect(pages[3]).toEqual([0xe1, 0x10, 0x12, 0x00]);
  });

  it("lays the TLV starting at page 4, zero-padded", () => {
    expect(pages[4]).toEqual([0x03, 0x1b, 0xd1, 0x01]);
    expect(pages[11]).toEqual([0x6d, 0xfe, 0x00, 0x00]); // last URI byte, terminator, pad
    expect(pages[12]).toEqual([0x00, 0x00, 0x00, 0x00]);
  });

  it("round-trips: the user pages decode back to the URI", () => {
    const user = Buffer.from(pages.slice(4, 40).flat());
    expect(decodeUri(user)).toBe(URI);
  });

  it("has a well-formed placeholder UID (valid BCC0)", () => {
    // BCC0 = CT(0x88) ^ UID0 ^ UID1 ^ UID2
    expect(pages[0]![3]).toBe(
      0x88 ^ pages[0]![0]! ^ pages[0]![1]! ^ pages[0]![2]!,
    );
  });

  it("rejects a URI that won't fit NTAG213 user memory", () => {
    expect(() => ntag213Pages("x".repeat(150))).toThrow(/user memory/);
  });
});

describe("flipperNfcFile", () => {
  const file = flipperNfcFile(ID);

  it("is a Flipper NFC device file for an NTAG213 with the NDEF pages", () => {
    expect(file).toContain("Filetype: Flipper NFC device");
    expect(file).toContain("Device type: NTAG213");
    expect(file).toContain("Page 3: E1 10 12 00");
    expect(file).toContain("Page 4: 03 1B D1 01");
    expect(file).toContain("Page 11: 6D FE 00 00");
    expect(file).toMatch(/Page 44: 00 00 00 00\n$/);
  });
});

describe("tag routes (issue #67)", () => {
  const server = () => {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-tag-")));
    const { app } = buildServer({ store, roadie: fakeRoadie(store) });
    return { app, store };
  };

  it("GET /api/albums/:id/tag.nfc downloads the album's .nfc", async () => {
    const { app, store } = server();
    store.save(makeAsset(ID, "Purple Rain", "Prince"));
    const res = await app.inject({
      method: "GET",
      url: `/api/albums/${ID}/tag.nfc`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`${ID}.nfc`);
    expect(res.body).toContain("Page 4: 03 1B D1 01");
  });

  it("GET /api/albums/:id/tag.nfc?object=card downloads the card .nfc", async () => {
    const { app, store } = server();
    store.save(makeAsset(ID, "Purple Rain", "Prince"));
    const res = await app.inject({
      method: "GET",
      url: `/api/albums/${ID}/tag.nfc?object=card`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`${ID}-card.nfc`);
    // card URI is one byte shorter than the album's, so the TLV length is 0x1A not 0x1B.
    expect(res.body).toContain("Page 4: 03 1A D1 01");
  });

  it("404s the .nfc for an unknown album", async () => {
    const { app } = server();
    const res = await app.inject({
      method: "GET",
      url: "/api/albums/zzzzzzzz/tag.nfc",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/tags/pending lists albums awaiting a tag write", async () => {
    const { app, store } = server();
    const a = makeAsset(ID, "Purple Rain", "Prince");
    a.roadie.state = "awaiting_tag_write";
    store.save(a);
    store.save(makeAsset("aaaa1111", "1999", "Prince")); // awaiting_review — excluded
    const { pending } = (
      await app.inject({ method: "GET", url: "/api/tags/pending" })
    ).json();
    expect(pending).toEqual([
      { curatorId: ID, name: "Purple Rain", artist: "Prince" },
    ]);
  });
});
