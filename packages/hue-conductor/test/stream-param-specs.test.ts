import { describe, it, expect } from "vitest";
import {
  STREAM_PARAM_SPECS,
  STREAM_PATTERN_TYPES,
  type StreamPatternType,
} from "@marquee/contracts";
import { STREAM_RENDERER_DEFAULTS } from "../src/stream/renderers.js";

/**
 * The real drift guard for ADR 0036.
 *
 * `STREAM_PARAM_SPECS` (contracts) mirrors `STREAM_RENDERER_DEFAULTS` (here) so Curator can draw a
 * slider that starts where an untouched album actually plays. Two declarations of the same numbers
 * rot, and this one rots *silently* — nothing breaks, every slider just lies about its resting
 * position, on every album at once.
 *
 * It lives in this package because this is the only place that can see both sides: hue-conductor
 * owns the renderers and depends on contracts. A version of this test in Curator could only compare
 * the spec against numbers copied out of it, which is what the first attempt did — it would have
 * passed for any renderer change at all.
 */
describe("STREAM_PARAM_SPECS mirrors the renderers", () => {
  it("declares the same effects", () => {
    expect(Object.keys(STREAM_RENDERER_DEFAULTS).sort()).toEqual(
      [...STREAM_PATTERN_TYPES].sort(),
    );
  });

  it.each(STREAM_PATTERN_TYPES)(
    "declares %s's knobs and no others",
    (effect) => {
      const rendererKeys = Object.keys(STREAM_RENDERER_DEFAULTS[effect]).sort();
      const specKeys = STREAM_PARAM_SPECS[effect].map((s) => s.key).sort();
      expect(specKeys).toEqual(rendererKeys);
    },
  );

  it.each(STREAM_PATTERN_TYPES)("uses %s's real defaults", (effect) => {
    const renderer = STREAM_RENDERER_DEFAULTS[effect] as Record<string, number>;
    const spec = Object.fromEntries(
      STREAM_PARAM_SPECS[effect].map((s) => [s.key, s.default]),
    );
    expect(spec).toEqual(renderer);
  });

  it("keeps every renderer default inside the slider's range", () => {
    // Otherwise an untouched album can't be represented by its own slider.
    for (const effect of STREAM_PATTERN_TYPES) {
      for (const spec of STREAM_PARAM_SPECS[effect]) {
        const actual = (
          STREAM_RENDERER_DEFAULTS[effect as StreamPatternType] as Record<
            string,
            number
          >
        )[spec.key]!;
        expect(actual).toBeGreaterThanOrEqual(spec.min);
        expect(actual).toBeLessThanOrEqual(spec.max);
      }
    }
  });
});
