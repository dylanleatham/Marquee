import { describe, it, expect } from "vitest";
import { hexToRgb } from "../src/color.js";

describe("hexToRgb", () => {
  it("parses #RRGGBB (Purple Rain primary)", () => {
    expect(hexToRgb("#4B0082")).toEqual({ r: 75, g: 0, b: 130 });
  });

  it("accepts lowercase and a missing leading #", () => {
    expect(hexToRgb("ffd700")).toEqual({ r: 255, g: 215, b: 0 });
  });

  it("handles black and white bounds", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("throws on malformed input", () => {
    expect(() => hexToRgb("nope")).toThrow(/invalid hex/i);
    expect(() => hexToRgb("#12345")).toThrow();
  });
});
