import { describe, it, expect } from "vitest";
import {
  STREAM_PARAM_SPECS,
  STREAM_PATTERN_TYPES,
  validateStreamParams,
} from "@marquee/contracts";

// ADR 0036. These knobs are not derived from anything — they're the renderers' own defaults — which
// is precisely why tuning them is a different decision from tuning a CLIP pattern (ADR 0030).
describe("STREAM_PARAM_SPECS", () => {
  it("covers every streaming effect", () => {
    for (const effect of STREAM_PATTERN_TYPES) {
      expect(STREAM_PARAM_SPECS[effect].length).toBeGreaterThan(0);
    }
  });

  it("puts every default inside its own range", () => {
    // A default outside its bounds would make the slider unable to represent an untouched album.
    for (const effect of STREAM_PATTERN_TYPES) {
      for (const spec of STREAM_PARAM_SPECS[effect]) {
        expect(spec.default).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default).toBeLessThanOrEqual(spec.max);
        expect(spec.max).toBeGreaterThan(spec.min);
        expect(spec.step).toBeGreaterThan(0);
      }
    }
  });

  it("matches the renderers' documented defaults", () => {
    // Drift guard: these mirror hue-conductor/src/stream/renderers.ts. If a renderer default moves
    // and this doesn't, the UI shows the wrong "untouched" position for every album.
    const byKey = (
      effect: (typeof STREAM_PATTERN_TYPES)[number],
      key: string,
    ) => STREAM_PARAM_SPECS[effect].find((s) => s.key === key)?.default;
    expect(byKey("aurora", "speed")).toBe(0.06);
    expect(byKey("aurora", "scale")).toBe(1.2);
    expect(byKey("aurora", "brightness")).toBe(1);
    expect(byKey("shimmer", "speed")).toBe(1.5);
    expect(byKey("shimmer", "intensity")).toBe(0.35);
    expect(byKey("wave", "speed")).toBe(0.25);
    expect(byKey("wave", "angleDeg")).toBe(0);
  });

  it("gives every knob a label and a plain-language hint", () => {
    for (const effect of STREAM_PATTERN_TYPES) {
      for (const spec of STREAM_PARAM_SPECS[effect]) {
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("validateStreamParams", () => {
  it("accepts a value inside the range", () => {
    expect(validateStreamParams("aurora", { speed: 0.2 })).toEqual({
      speed: 0.2,
    });
  });

  it("treats absent params as none", () => {
    expect(validateStreamParams("aurora", undefined)).toEqual({});
    expect(validateStreamParams("aurora", null)).toEqual({});
    expect(validateStreamParams("aurora", {})).toEqual({});
  });

  it("drops a value equal to the default rather than storing it", () => {
    // "Untouched" and "explicitly set to the default" must not become two states that look the
    // same today and diverge if a renderer default ever changes.
    expect(validateStreamParams("aurora", { speed: 0.06 })).toEqual({});
    expect(validateStreamParams("aurora", { speed: 0.06, scale: 2 })).toEqual({
      scale: 2,
    });
  });

  it("rejects a knob that belongs to a different effect", () => {
    // `scale` is aurora's; wave has no such knob, and silently ignoring it would lose an edit.
    expect(() => validateStreamParams("wave", { scale: 2 })).toThrow(
      /unknown param/,
    );
  });

  it("rejects a value outside the range, naming the bounds", () => {
    expect(() => validateStreamParams("aurora", { speed: 99 })).toThrow(
      /between 0.01 and 0.5/,
    );
    expect(() => validateStreamParams("shimmer", { intensity: -1 })).toThrow(
      /between 0 and 1/,
    );
  });

  it("rejects non-numbers, including the ones JSON makes easy to send", () => {
    for (const bad of ["0.2", true, null, {}, []]) {
      expect(() => validateStreamParams("aurora", { speed: bad })).toThrow(
        /finite number/,
      );
    }
    expect(() => validateStreamParams("aurora", { speed: NaN })).toThrow(
      /finite number/,
    );
  });

  it("rejects a params value that isn't an object", () => {
    expect(() => validateStreamParams("aurora", 5)).toThrow(
      /must be an object/,
    );
    expect(() => validateStreamParams("aurora", [1, 2])).toThrow(
      /must be an object/,
    );
  });

  it("accepts every knob at both bounds", () => {
    for (const effect of STREAM_PATTERN_TYPES) {
      for (const spec of STREAM_PARAM_SPECS[effect]) {
        expect(() =>
          validateStreamParams(effect, { [spec.key]: spec.min }),
        ).not.toThrow();
        expect(() =>
          validateStreamParams(effect, { [spec.key]: spec.max }),
        ).not.toThrow();
      }
    }
  });
});
