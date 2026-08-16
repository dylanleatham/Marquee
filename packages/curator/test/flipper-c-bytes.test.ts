// The FAP's NDEF compose (C) against Route A's (TypeScript) — issue #68.
//
// The byte layout is defined once and implemented three times: Curator generates it, Stylus parses
// it, and the Flipper app composes it on-device. Curator↔Stylus already has a contract test; this
// closes the third leg, which until now was "keep it byte-identical" enforced by eyeball.
//
// No compiler is involved. The C function writes the TLV as a short sequence of literal byte
// constants, so we read the source, pull the constants out of `marquee_build_ndef_tlv`, and check
// them against the bytes `ndefUriTlv` actually produces at the same offsets. That catches the
// realistic drift — someone "fixing" a header byte, a type code, or the prefix byte on one side only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ndefUriTlv, tagUri, TAG_OBJECTS } from "../src/tags/flipper-nfc.js";
import { MAX_ALBUMS_ON_DEVICE } from "../src/tags/flipper-push.js";

const repoRoot = new URL("../../../", import.meta.url);
const C_SOURCE = fileURLToPath(
  new URL("flipper/marquee-tag-writer/marquee_tag_writer.c", repoRoot),
);

const source = readFileSync(C_SOURCE, "utf8");

/** The body of a `static` C function, by name — so we only read the one we mean, not the file. */
function functionBody(name: string): string {
  const at = source.search(new RegExp(`static [\\w* ]+\\b${name}\\(`));
  expect(at, `${name} not found in ${C_SOURCE}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Every `out[i++] = 0xNN;` in order — the fixed bytes the C writes around the ASCII URI. */
function literalBytes(body: string): number[] {
  return [...body.matchAll(/out\[i\+\+\]\s*=\s*(0x[0-9a-fA-F]{2})\s*;/g)].map(
    (m) => Number(m[1]),
  );
}

describe("the FAP's NDEF compose matches Route A byte for byte (#68)", () => {
  const body = functionBody("marquee_build_ndef_tlv");
  const literals = literalBytes(body);

  it("emits the fixed header bytes Route A does, in the same order", () => {
    // Route A's TLV for a sleeve: 03 <len> D1 01 <plen> 55 00 <ascii…> FE. The two length bytes are
    // computed in both implementations, so the literals are the header constants plus the terminator.
    expect(literals).toEqual([0x03, 0xd1, 0x01, 0x55, 0x00, 0xfe]);

    const expected = ndefUriTlv(tagUri("2k7bxq9m", "sleeve"));
    expect([
      expected[0], // TLV type
      expected[2], // record header: MB|ME|SR, TNF=well-known
      expected[3], // type length
      expected[5], // type 'U'
      expected[6], // URI prefix code: none
      expected[expected.length - 1], // terminator
    ]).toEqual(literals);
  });

  it("computes the same two length bytes as Route A", () => {
    // C: payload_len = 1 + uri_len, record_len = 4 + payload_len, and the TLV length byte is
    // record_len. Assert those relationships hold against real Route A output for both kinds.
    expect(body).toMatch(/payload_len\s*=\s*\(uint8_t\)\(1 \+ uri_len\)/);
    expect(body).toMatch(/record_len\s*=\s*\(uint8_t\)\(4 \+ payload_len\)/);

    for (const object of TAG_OBJECTS) {
      const uri = tagUri("2k7bxq9m", object);
      const tlv = ndefUriTlv(uri);
      expect(tlv[1], "TLV length = 4 + 1 + uri length").toBe(
        4 + 1 + uri.length,
      );
      expect(tlv[4], "payload length = 1 + uri length").toBe(1 + uri.length);
    }
  });

  /**
   * The kind *words* are the third place the URI scheme is implemented, and the one no test could
   * catch by reading bytes: a FAP that wrote `curator:demo:` where Curator writes `curator:cut:`
   * produces a perfectly well-formed tag that resolves to nothing in the room. So the C's word
   * table is read out of the source and checked against Route A's output for every object.
   */
  it("builds the URI with the same scheme and kinds as Route A", () => {
    expect(source).toContain('"curator:%s:%s"');

    // Sorted: the C returns them in guard order (the default last), Route A in object order. What
    // must match is the *set* of words, not which branch happens to come first.
    const words = functionBody("tag_kind_word");
    const cKinds = [...words.matchAll(/return "([a-z]+)";/g)].map((m) => m[1]);
    expect(cKinds.sort()).toEqual(
      TAG_OBJECTS.map((o) => tagUri("2k7bxq9m", o).split(":")[1]).sort(),
    );

    expect(tagUri("2k7bxq9m", "sleeve")).toBe("curator:album:2k7bxq9m");
    expect(tagUri("2k7bxq9m", "card")).toBe("curator:card:2k7bxq9m");
    expect(tagUri("2k7bxq9m", "demo")).toBe("curator:demo:2k7bxq9m");
  });

  /**
   * The confirm screen is the only place that says which kind you just wrote, and per the spec it is
   * what stops you writing forty wrong tags — so naming the wrong kind defeats its purpose (#272).
   * It said "Sleeve tag written" for a demo tag because the header was a two-way ternary over a
   * three-valued enum, and a ternary does not fail to compile when a kind is added.
   *
   * The gate is structural, not a string match: every user-facing kind label must come out of
   * `tag_kind_short`, which is exhaustive by construction, rather than a branch that has a default.
   */
  it("names the kind on every screen from one exhaustive helper", () => {
    const shortBody = functionBody("tag_kind_short");
    const cShorts = [...shortBody.matchAll(/return "(\w+)";/g)].map(
      (m) => m[1],
    );
    expect(
      cShorts.length,
      "tag_kind_short must name every object Route A can author",
    ).toBe(TAG_OBJECTS.length);

    // Nothing may re-derive a label by comparing the kind itself. The one place that legitimately
    // decides a kind (`on_kind_selected`) switches on the menu index, not on `tag_kind`.
    expect(
      [...source.matchAll(/tag_kind\s*==\s*TagKind\w+/g)].map((m) => m[0]),
      "branch on tag_kind and a new kind silently takes the default — call tag_kind_short instead",
    ).toEqual([]);

    const resultBody = functionBody("show_result");
    expect(
      resultBody,
      "the write-success header must name the kind that was written",
    ).toMatch(/tag_kind_short\(app->tag_kind\)/);
  });

  it("offers every object as a kind the menu can choose", () => {
    // A kind Curator can author but the FAP cannot offer is a tag you have to write another way.
    expect(source).toMatch(/TagKindSleeve,\s*TagKindCard,\s*TagKindDemo,/);
    expect(source).toContain("MENU_KIND_DEMO");
    expect(source).toContain('"Demo (one song)"');
  });

  /**
   * The other number shared across the two languages. The FAP stops parsing at `MAX_ALBUMS` and the
   * menu just ends — no glyph, no log the user can see — so Curator has to know the same cap to be
   * able to say "the last N didn't fit". A C-side bump that Curator never hears about turns that
   * report into a lie in the safe direction; a TS-side bump turns it into silence.
   */
  it("caps the album list at the same number Curator reports overflow against", () => {
    const cap = source.match(/#define MAX_ALBUMS (\d+)/);
    expect(cap, "MAX_ALBUMS not found in the C source").not.toBeNull();
    expect(Number(cap![1])).toBe(MAX_ALBUMS_ON_DEVICE);
  });

  it("lays the TLV into the same pages Route A does", () => {
    // Page 3 is the CC, the TLV starts at page 4, user memory ends at 39.
    expect(source).toMatch(/#define NTAG_CC_PAGE 3/);
    expect(source).toMatch(/#define NTAG_USER_PAGE_START 4/);
    expect(source).toMatch(/#define NTAG_USER_PAGE_END 39/);
    expect(source).toMatch(
      /kNtag213Cc\[NTAG_PAGE_SIZE\] = \{0xE1, 0x10, 0x12, 0x00\}/,
    );
  });
});
