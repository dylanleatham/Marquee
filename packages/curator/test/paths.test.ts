import { describe, it, expect } from "vitest";
import { Paths } from "../src/store/paths.js";

describe("Paths.relPosix", () => {
  const p = new Paths("/data/marquee");

  it("returns a POSIX path relative to dataDir when the file is inside it", () => {
    expect(p.relPosix("/data/marquee/media/artwork/x.jpg")).toBe(
      "media/artwork/x.jpg",
    );
  });

  it("falls back to a POSIX form of the absolute path when outside dataDir", () => {
    expect(p.relPosix("/somewhere/else/y.jpg")).toBe("/somewhere/else/y.jpg");
  });
});
