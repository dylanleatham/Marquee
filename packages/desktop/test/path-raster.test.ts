// The two pieces of geometry behind the app icon, exercised directly rather than through a 512×512
// render of one particular logo. Both are new and neither is obvious: a subdivision that is too
// coarse shows up as faceted curves, and a fill that ignores winding turns every counter into a
// blot. Against the mark those failures are a slightly-wrong picture; here they are an assertion.
import { describe, it, expect } from "vitest";

// Imported via a variable so tsc doesn't try to type the plain-JS .mjs generator script.
const modPath = "../scripts/make-icon.mjs";

type Pt = [number, number];
const load = async () =>
  (await import(modPath)) as {
    flatten: (d: string, tol?: number) => Pt[][];
    rasterize: (
      paths: string[],
      scale: number,
      offX: number,
      offY: number,
    ) => Float32Array;
    parsePaths: (svg: string) => string[];
  };

describe("flatten", () => {
  it("keeps the endpoints exact and walks the curve in between", async () => {
    const { flatten } = await load();
    // The standard 4/3·tan(π/8) ≈ 0.5523 cubic approximation of a quarter circle: (100,0) round to
    // (0,100), centred on the origin. Every flattened point should land on that circle.
    const k = 55.23;
    const [poly] = flatten(`M100,0C100,${k} ${k},100 0,100Z`);

    expect(poly![0]).toEqual([100, 0]);
    expect(poly![poly!.length - 1]).toEqual([0, 100]);
    expect(poly!.length).toBeGreaterThan(8); // not a single chord across the arc

    const worst = Math.max(
      ...poly!.map(([x, y]) => Math.abs(Math.hypot(x, y) - 100)),
    );
    expect(worst).toBeLessThan(0.5); // the Bezier's own error against a true circle is ~0.03%
  });

  it("subdivides a longer curve more finely", async () => {
    const { flatten } = await load();
    const small = flatten("M0,0C1,1 2,1 3,0Z");
    const large = flatten("M0,0C100,100 200,100 300,0Z");
    expect(large![0]!.length).toBeGreaterThan(small![0]!.length);
  });

  it("treats coordinate pairs after an M as linetos, the way SVG does", async () => {
    const { flatten } = await load();
    // "M0,0 10,0 10,10" is a move plus two implicit lines — not three moves.
    const polys = flatten("M0,0 10,0 10,10Z");
    expect(polys.length).toBe(1);
    expect(polys[0]).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it("refuses a command it cannot draw instead of mangling the shape", async () => {
    const { flatten } = await load();
    // Regression: the tokenizer used to match only /[MLCZ]/, so an `A` was dropped on the floor and
    // its arguments were read as coordinates for the previous command. The shape came out wrong and
    // nothing said so. Arcs and quadratics must be an error, not a silent redraw.
    expect(() => flatten("M0,0A10,10 0 0 1 10,10Z")).toThrow(
      /unsupported path command "A"/,
    );
    expect(() => flatten("M0,0Q5,5 10,10Z")).toThrow(
      /unsupported path command "Q"/,
    );
  });

  it("refuses relative commands rather than drawing them as absolute", async () => {
    const { flatten } = await load();
    // Regression: `.toUpperCase()` turned a relative `c` into an absolute `C`. That renders — as
    // the wrong shape. Our mark is normalized to absolute on the way in, so this is a bad input.
    expect(() => flatten("M0,0c1,1 2,1 3,0Z")).toThrow(
      /unsupported path command "c"/,
    );
    expect(() => flatten("M0,0l10,0Z")).toThrow(/unsupported path command "l"/);
  });
});

describe("rasterize", () => {
  /** A 100×100 square at (0,0) with a 40×40 counter-wound square inside it — a donut. */
  const outer = "M0,0L100,0L100,100L0,100Z";
  const holeReversed = "M30,30L30,70L70,70L70,30Z"; // opposite direction to `outer`
  const holeSameWay = "M30,30L70,30L70,70L30,70Z";

  it("makes an opposite-wound inner contour a hole", async () => {
    const { rasterize } = await load();
    const cov = rasterize([`${outer}${holeReversed}`], 1, 0, 0);
    const at = (x: number, y: number) => cov[y * 512 + x]!;

    expect(at(10, 50)).toBeCloseTo(1, 2); // the ring
    expect(at(50, 50)).toBeCloseTo(0, 2); // the hole
    expect(at(200, 200)).toBeCloseTo(0, 2); // outside everything
  });

  it("fills a same-wound inner contour solid — winding, not just containment", async () => {
    const { rasterize } = await load();
    // Wind the inner square the same way and nonzero gives 2, not 0. This is the difference
    // between the nonzero rule and even-odd, and between it and 'any enclosed region is a hole'.
    const cov = rasterize([`${outer}${holeSameWay}`], 1, 0, 0);
    expect(cov[50 * 512 + 50]).toBeCloseTo(1, 2);
  });

  it("unions separate paths rather than letting their windings cancel", async () => {
    const { rasterize } = await load();
    // Two overlapping squares wound in opposite directions. Filled as one path they would cancel
    // to nothing where they overlap; as separate paths the overlap stays covered.
    const a = "M0,0L100,0L100,100L0,100Z";
    const b = "M50,50L50,150L150,150L150,50Z";
    const cov = rasterize([a, b], 1, 0, 0);
    expect(cov[75 * 512 + 75]).toBeCloseTo(1, 2); // the overlap
  });

  it("antialiases an edge rather than snapping it to whole pixels", async () => {
    const { rasterize } = await load();
    // An edge at x=10.5 should leave that pixel column half-covered.
    const cov = rasterize(["M0,0L10.5,0L10.5,100L0,100Z"], 1, 0, 0);
    expect(cov[50 * 512 + 9]).toBeCloseTo(1, 2);
    expect(cov[50 * 512 + 10]).toBeCloseTo(0.5, 1);
    expect(cov[50 * 512 + 11]).toBeCloseTo(0, 2);
  });

  it("applies the scale and offset it is given", async () => {
    const { rasterize } = await load();
    const cov = rasterize([outer], 2, 100, 100); // 100×100 → 200×200 at (100,100)
    expect(cov[150 * 512 + 150]).toBeCloseTo(1, 2);
    expect(cov[150 * 512 + 50]).toBeCloseTo(0, 2);
    expect(cov[150 * 512 + 350]).toBeCloseTo(0, 2);
  });
});

describe("parsePaths", () => {
  it("reads every path's d, in document order", async () => {
    const { parsePaths } = await load();
    const svg = `<svg viewBox="0 0 1 1"><path d="M0,0Z"/><path id="x" d="M1,1Z"/></svg>`;
    expect(parsePaths(svg)).toEqual(["M0,0Z", "M1,1Z"]);
  });
});
