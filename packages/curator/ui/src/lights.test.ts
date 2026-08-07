// Where each light lands in the room (ADR 0052). The point of this module is that a colour's slot
// describes the room, not the data model — so the tests are about the words and about order being
// the edit.
import { describe, it, expect } from "vitest";
import {
  describeLight,
  lightRows,
  MAX_LIGHTS,
  paletteSignature,
  toEditable,
  validHex,
} from "./lights";

describe("describeLight", () => {
  it("names where the first three land, in plain English", () => {
    expect(describeLight(0)).toMatchObject({
      role: "DOMINANT",
      note: "the wall wash",
    });
    expect(describeLight(1)).toMatchObject({
      role: "SECOND",
      note: "the far corner",
    });
    expect(describeLight(2)).toMatchObject({
      role: "ACCENT",
      note: "the glow behind the stand",
    });
  });

  it("is honest about a fourth colour rather than inventing a place for it", () => {
    // Past the third there is no location of its own — the runtime cycles it. Naming a fake corner
    // would be a promise the lights don't keep.
    expect(describeLight(3).role).toBe("SPARE");
    expect(describeLight(9).note).toBe("held in reserve");
  });

  it("keeps the positional API role the server stores", () => {
    expect(describeLight(0).apiRole).toBe("primary");
    expect(describeLight(1).apiRole).toBe("secondary");
    expect(describeLight(2).apiRole).toBe("accent");
  });
});

describe("lightRows", () => {
  it("reads roles off position, so reordering is the edit", () => {
    const rows = lightRows([{ hex: "#4b0082" }, { hex: "#ffd700" }]);
    expect(rows.map((r) => r.role)).toEqual(["DOMINANT", "SECOND"]);
    // Swap them and the meaning follows the order — nothing per-row is stored.
    const swapped = lightRows([{ hex: "#ffd700" }, { hex: "#4b0082" }]);
    expect(swapped[0]!.hex).toBe("#FFD700");
    expect(swapped[0]!.role).toBe("DOMINANT");
  });

  it("upper-cases hexes so the list doesn't read as two different formats", () => {
    expect(lightRows([{ hex: "#4b0082" }])[0]!.hex).toBe("#4B0082");
  });
});

describe("validHex", () => {
  it("accepts a full six-digit hex and normalises its case", () => {
    expect(validHex("#4b0082")).toBe("#4B0082");
  });

  it("rejects anything a half-typed field produces", () => {
    // This is what holds the autosave back mid-typing rather than PUTting "#12" and 400ing.
    for (const bad of ["#12", "#", "", "4B0082", "#GGGGGG", "#4b00821"])
      expect(validHex(bad)).toBeNull();
  });
});

describe("paletteSignature", () => {
  it("is case-insensitive, so a normalisation is not mistaken for an edit", () => {
    expect(paletteSignature([{ hex: "#4b0082" }])).toBe(
      paletteSignature([{ hex: "#4B0082" }]),
    );
  });

  it("changes when the order does", () => {
    const a = [{ hex: "#111111" }, { hex: "#222222" }];
    expect(paletteSignature(a)).not.toBe(paletteSignature([...a].reverse()));
  });
});

describe("toEditable", () => {
  it("survives an absent palette and a stored hex the editor can't render", () => {
    expect(toEditable(undefined)).toEqual([]);
    expect(toEditable([{ hex: "not-a-colour", role: "primary" }])[0]!.hex).toBe(
      "#000000",
    );
  });
});

describe("MAX_LIGHTS", () => {
  it("caps the room at eight", () => {
    expect(MAX_LIGHTS).toBe(8);
  });
});
