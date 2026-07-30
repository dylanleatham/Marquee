import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLIP_PATTERN_TYPES,
  PATTERN_PARAM_SPECS,
  PATTERN_TYPES,
  STREAM_PATTERN_TYPES,
  resolvePatternParams,
  validatePatternParams,
} from "@marquee/contracts";

// ADR 0036 (streaming knobs) widened to every pattern type by ADR 0039. These tune the *override*,
// never the derived pattern, which is why tuning them was a different decision from the pattern
// editor ADR 0030 declined.
//
// The streaming defaults are diffed against the renderers themselves in hue-conductor's
// stream-param-specs.test.ts — that's the only place both sides are visible. The CLIP defaults have
// no renderer constant to mirror, so their guard is the payload schema, asserted at the bottom here.
describe("PATTERN_PARAM_SPECS", () => {
  it("has an entry for every pattern type, so a new one can't ship unlisted", () => {
    for (const type of PATTERN_TYPES) {
      expect(PATTERN_PARAM_SPECS[type]).toBeDefined();
    }
  });

  it("gives every type but static at least one knob", () => {
    for (const type of PATTERN_TYPES) {
      if (type === "static") continue;
      expect(PATTERN_PARAM_SPECS[type].length).toBeGreaterThan(0);
    }
    // static holds the palette still — an empty knob rack is the honest answer, not an oversight.
    expect(PATTERN_PARAM_SPECS.static).toEqual([]);
  });

  it("puts every default inside its own range", () => {
    // A default outside its bounds would make the slider unable to represent an untouched album.
    for (const type of PATTERN_TYPES) {
      for (const spec of PATTERN_PARAM_SPECS[type]) {
        expect(spec.default).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default).toBeLessThanOrEqual(spec.max);
        expect(spec.max).toBeGreaterThan(spec.min);
        expect(spec.step).toBeGreaterThan(0);
      }
    }
  });

  it("gives every knob a label and a plain-language hint", () => {
    for (const type of PATTERN_TYPES) {
      for (const spec of PATTERN_PARAM_SPECS[type]) {
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps integer knobs integral at both bounds and at every step", () => {
    for (const type of PATTERN_TYPES) {
      for (const spec of PATTERN_PARAM_SPECS[type]) {
        if (!spec.integer) continue;
        expect(Number.isInteger(spec.min)).toBe(true);
        expect(Number.isInteger(spec.max)).toBe(true);
        expect(Number.isInteger(spec.default)).toBe(true);
        // A fractional step would let the slider land on a value the validator then rejects.
        expect(Number.isInteger(spec.step)).toBe(true);
      }
    }
  });
});

describe("validatePatternParams", () => {
  it("accepts a value inside the range", () => {
    expect(validatePatternParams("aurora", { speed: 0.2 })).toEqual({
      speed: 0.2,
    });
    expect(validatePatternParams("rotate", { intervalMs: 900 })).toEqual({
      intervalMs: 900,
    });
  });

  it("treats absent params as none", () => {
    expect(validatePatternParams("aurora", undefined)).toEqual({});
    expect(validatePatternParams("aurora", null)).toEqual({});
    expect(validatePatternParams("aurora", {})).toEqual({});
  });

  it("drops a value equal to the default rather than storing it", () => {
    // "Untouched" and "explicitly set to the default" must not become two states that look the
    // same today and diverge if a default ever changes.
    expect(validatePatternParams("aurora", { speed: 0.06 })).toEqual({});
    expect(validatePatternParams("aurora", { speed: 0.06, scale: 2 })).toEqual({
      scale: 2,
    });
    expect(validatePatternParams("crossfade", { holdMs: 30000 })).toEqual({});
  });

  it("rejects a knob that belongs to a different pattern", () => {
    // `scale` is aurora's; wave has no such knob, and silently ignoring it would lose an edit.
    expect(() => validatePatternParams("wave", { scale: 2 })).toThrow(
      /unknown param/,
    );
    expect(() => validatePatternParams("rotate", { holdMs: 5000 })).toThrow(
      /unknown param/,
    );
  });

  it("says plainly that static takes no params, rather than listing none", () => {
    expect(() => validatePatternParams("static", { intervalMs: 900 })).toThrow(
      /static takes no params/,
    );
  });

  it("rejects a value outside the range, naming the bounds", () => {
    expect(() => validatePatternParams("aurora", { speed: 99 })).toThrow(
      /between 0.01 and 0.5/,
    );
    expect(() => validatePatternParams("shimmer", { intensity: -1 })).toThrow(
      /between 0 and 1/,
    );
    expect(() => validatePatternParams("rotate", { intervalMs: 10 })).toThrow(
      /between 400 and 6000/,
    );
  });

  it("rejects a fractional value where the payload schema wants an integer", () => {
    // Otherwise it passes here and Conductor's own contract rejects it later, which is a worse
    // place to find out (ADR 0039).
    expect(() =>
      validatePatternParams("rotate", { intervalMs: 900.5 }),
    ).toThrow(/whole number/);
    expect(() =>
      validatePatternParams("crossfade", { holdMs: 30000.5 }),
    ).toThrow(/whole number/);
  });

  it("allows a fractional value where the schema does not demand an integer", () => {
    expect(validatePatternParams("pulse", { minBrightness: 42.5 })).toEqual({
      minBrightness: 42.5,
    });
  });

  it("rejects a pulse that would dim past its own ceiling", () => {
    expect(() =>
      validatePatternParams("pulse", { minBrightness: 80, maxBrightness: 20 }),
    ).toThrow(/below/);
  });

  it("judges a lone pulse knob against the default it will play beside", () => {
    // maxBrightness defaults to 100, so a min of 80 is fine on its own...
    expect(validatePatternParams("pulse", { minBrightness: 80 })).toEqual({
      minBrightness: 80,
    });
    // ...but a lone max below the default min is not.
    expect(() => validatePatternParams("pulse", { maxBrightness: 20 })).toThrow(
      /below/,
    );
  });

  it("rejects non-numbers, including the ones JSON makes easy to send", () => {
    for (const bad of ["0.2", true, null, {}, []]) {
      expect(() => validatePatternParams("aurora", { speed: bad })).toThrow(
        /finite number/,
      );
    }
    expect(() => validatePatternParams("aurora", { speed: NaN })).toThrow(
      /finite number/,
    );
  });

  it("rejects a params value that isn't an object", () => {
    expect(() => validatePatternParams("aurora", 5)).toThrow(
      /must be an object/,
    );
    expect(() => validatePatternParams("aurora", [1, 2])).toThrow(
      /must be an object/,
    );
  });

  it("accepts every knob at both bounds", () => {
    for (const type of PATTERN_TYPES) {
      for (const spec of PATTERN_PARAM_SPECS[type]) {
        // pulse's two brightness knobs bound each other; covered by their own cases above.
        if (type === "pulse" && spec.key !== "periodMs") continue;
        expect(() =>
          validatePatternParams(type, { [spec.key]: spec.min }),
        ).not.toThrow();
        expect(() =>
          validatePatternParams(type, { [spec.key]: spec.max }),
        ).not.toThrow();
      }
    }
  });
});

describe("resolvePatternParams", () => {
  it("fills every knob the human didn't move with its default", () => {
    expect(resolvePatternParams("crossfade", { holdMs: 5000 })).toEqual({
      transitionMs: 8000,
      holdMs: 5000,
    });
  });

  it("resolves an untouched override to a complete param set", () => {
    // `pattern.params` is required per type in the payload contract — a rotate with no intervalMs
    // is not a legal payload, however little the human touched.
    expect(resolvePatternParams("rotate", undefined)).toEqual({
      intervalMs: 1200,
      direction: "forward",
    });
    expect(resolvePatternParams("static", {})).toEqual({});
  });

  it("carries rotate's direction, which is an enum rather than a knob (ADR 0039)", () => {
    expect(resolvePatternParams("rotate", {}).direction).toBe("forward");
  });
});

/**
 * The CLIP half's drift guard (ADR 0039). The streaming specs mirror renderer constants and are
 * diffed against them in hue-conductor; the CLIP specs have no such constant, so what they must
 * agree with is `palette-payload.schema.json` — every value a slider can reach has to satisfy the
 * contract Conductor validates against, or the UI can mint an asset the runtime refuses to play.
 */
describe("CLIP specs satisfy palette-payload.schema.json", () => {
  interface Constraint {
    type?: string;
    minimum?: number;
    maximum?: number;
  }
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../contracts/schemas/palette-payload.schema.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as {
    properties: {
      pattern: {
        oneOf: Array<{
          properties: {
            type: { const?: string };
            params: {
              required?: string[];
              properties?: Record<string, Constraint>;
            };
          };
        }>;
      };
    };
  };

  const branchFor = (type: string) =>
    schema.properties.pattern.oneOf.find(
      (b) => b.properties.type.const === type,
    );

  it.each(CLIP_PATTERN_TYPES)("has a schema branch for %s", (type) => {
    expect(branchFor(type)).toBeDefined();
  });

  it.each(CLIP_PATTERN_TYPES)(
    "resolves %s to exactly the params its branch requires",
    (type) => {
      // A missing required key is the failure the resolver exists to prevent: an override the human
      // barely touched still has to be a complete, legal pattern.
      const resolved = resolvePatternParams(type, {});
      for (const key of branchFor(type)?.properties.params.required ?? [])
        expect(Object.keys(resolved)).toContain(key);
    },
  );

  it.each(CLIP_PATTERN_TYPES)(
    "keeps every %s knob's whole range inside its schema constraint",
    (type) => {
      const props = branchFor(type)?.properties.params.properties ?? {};
      for (const spec of PATTERN_PARAM_SPECS[type]) {
        const c = props[spec.key];
        expect(c, `${type}.${spec.key} is not in the schema`).toBeDefined();
        if (c?.minimum !== undefined)
          expect(spec.min).toBeGreaterThanOrEqual(c.minimum);
        if (c?.maximum !== undefined)
          expect(spec.max).toBeLessThanOrEqual(c.maximum);
        // The `integer` flag is what stops a slider producing a fractional value the schema bans,
        // so the two have to agree about which knobs those are.
        if (c?.type === "integer") expect(spec.integer).toBe(true);
      }
    },
  );
});

describe("STREAM_PATTERN_TYPES / CLIP_PATTERN_TYPES", () => {
  it("partition PATTERN_TYPES with no overlap and nothing left over", () => {
    expect([...CLIP_PATTERN_TYPES, ...STREAM_PATTERN_TYPES].sort()).toEqual(
      [...PATTERN_TYPES].sort(),
    );
    expect(
      CLIP_PATTERN_TYPES.filter((t) =>
        (STREAM_PATTERN_TYPES as readonly string[]).includes(t),
      ),
    ).toEqual([]);
  });
});
