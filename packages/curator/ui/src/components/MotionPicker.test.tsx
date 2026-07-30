import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MotionPicker } from "./MotionPicker";
import { api, type AlbumAsset } from "../api";
import { PATTERN_PARAM_SPECS, PATTERN_TYPES } from "@marquee/contracts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The narrow slice of an asset this component reads. */
const asset = (over: Partial<AlbumAsset> = {}): AlbumAsset =>
  ({
    curatorId: "abcd1234",
    pattern: {
      type: "crossfade",
      params: { transitionMs: 8000, holdMs: 30000 },
    },
    ...over,
  }) as AlbumAsset;

/** Run the action immediately, as AlbumDetail's runner does. */
const run = (fn: () => Promise<unknown>) => fn().then(() => undefined);

const draw = (a: AlbumAsset = asset()) =>
  render(<MotionPicker curatorId="abcd1234" asset={a} run={run} />);

const stubSet = () =>
  vi.spyOn(api, "setPatternOverride").mockResolvedValue({
    patternOverride: null,
    patternOverrideParams: {},
    pattern: undefined,
  });

describe("MotionPicker (ADR 0039)", () => {
  it("offers Auto plus every pattern type, CLIP and streaming alike", () => {
    draw();
    for (const label of [
      "Auto",
      "Static",
      "Rotate",
      "Pulse",
      "Crossfade",
      "Aurora",
      "Shimmer",
      "Wave",
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^(✓ )?${label}$`) }),
      ).toBeTruthy();
    }
  });

  it("offers exactly one option per contract pattern type, so a new type can't go unlisted", () => {
    const { container } = draw();
    const chips = container.querySelectorAll(".motion__options .chip");
    expect(chips).toHaveLength(PATTERN_TYPES.length + 1); // + Auto
  });

  it("defaults to Auto, because motion is derived until a human says otherwise", () => {
    draw();
    expect(
      screen.getByRole("button", { name: /Auto/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it.each(["rotate", "crossfade", "shimmer"] as const)(
    "marks the album's current override (%s) as pressed",
    (type) => {
      draw(asset({ patternOverride: type }));
      const name = new RegExp(type, "i");
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        screen
          .getByRole("button", { name: /Auto/ })
          .getAttribute("aria-pressed"),
      ).toBe("false");
    },
  );

  it("marks selection with a glyph, not colour alone (curator-ui-ux §3.4)", () => {
    const { container } = draw(asset({ patternOverride: "rotate" }));
    expect(
      screen.getByRole("button", { name: /Rotate/ }).textContent,
    ).toContain("✓");
    // And exactly one option is ever marked.
    expect(container.textContent?.match(/✓/g)).toHaveLength(1);
  });

  it("says in words which options need hardware, rather than only grouping them", () => {
    draw();
    expect(
      screen.getByRole("group", { name: /entertainment area/i }),
    ).toBeTruthy();
    expect(screen.getByText(/needs an entertainment area/i)).toBeTruthy();
  });

  it("overrides to a CLIP pattern when one is clicked", () => {
    const set = stubSet();
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Rotate/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", "rotate");
  });

  it("overrides to a streaming effect when one is clicked", () => {
    const set = stubSet();
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Aurora/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", "aurora");
  });

  it("clears the override with null when Auto is clicked", () => {
    const set = stubSet();
    draw(asset({ patternOverride: "aurora" }));
    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", null);
  });

  it("names the derived pattern that plays on Auto", () => {
    draw();
    expect(screen.getByText(/derived pattern/)).toBeTruthy();
    expect(screen.getByText("crossfade")).toBeTruthy();
  });

  it("says a streaming pick needs hardware and what it falls back to", () => {
    const { container } = draw(asset({ patternOverride: "aurora" }));
    const note = container.querySelector(".motion__note")?.textContent ?? "";
    expect(note).toMatch(/entertainment area/);
    expect(note).toMatch(/falls back/);
    expect(note).toContain("crossfade");
  });

  it("says a CLIP pick plays anywhere and keeps the derived pattern", () => {
    // The distinction matters: one is hardware-gated with a fallback, the other isn't gated at all.
    const { container } = draw(asset({ patternOverride: "rotate" }));
    const note = container.querySelector(".motion__note")?.textContent ?? "";
    expect(note).toMatch(/any bridge/);
    expect(note).not.toMatch(/entertainment area/);
    expect(note).toMatch(/Auto/);
  });

  it("still renders when the album has no derived pattern yet", () => {
    const bare = asset();
    delete (bare as { pattern?: unknown }).pattern;
    draw(bare);
    expect(screen.getByRole("button", { name: /Auto/ })).toBeTruthy();
  });

  // ADR 0036's knobs, widened to CLIP by ADR 0039. These tune the override, never the derived
  // pattern — so there is still no computed value being edited in place.
  describe("params", () => {
    const sliders = () => screen.queryAllByRole("slider");

    it("shows no knobs on Auto", () => {
      draw();
      expect(sliders()).toHaveLength(0);
    });

    it("shows no knobs for static, which has nothing to tune", () => {
      draw(asset({ patternOverride: "static" }));
      expect(sliders()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /Reset to defaults/ })).toBe(
        null,
      );
    });

    it.each(["rotate", "pulse", "crossfade", "aurora"] as const)(
      "shows one slider per knob %s exposes",
      (type) => {
        draw(asset({ patternOverride: type }));
        expect(sliders()).toHaveLength(PATTERN_PARAM_SPECS[type].length);
      },
    );

    it("takes each slider's range and default from the shared spec", () => {
      // The server validates against this same source; a slider offering a rejected value would be
      // worse than no slider.
      draw(asset({ patternOverride: "crossfade" }));
      PATTERN_PARAM_SPECS.crossfade.forEach((spec, i) => {
        const el = sliders()[i] as HTMLInputElement;
        expect(el.min).toBe(String(spec.min));
        expect(el.max).toBe(String(spec.max));
        expect(el.step).toBe(String(spec.step));
        expect(el.value).toBe(String(spec.default));
      });
    });

    it("starts a CLIP override at the spec default, not the derived pattern's value", () => {
      // ADR 0039: the spec default is *the* default, so an override means the same thing whatever
      // it displaced. The album below derives crossfade at 8000/30000.
      draw(asset({ patternOverride: "crossfade" }));
      expect((sliders()[0] as HTMLInputElement).value).toBe(
        String(PATTERN_PARAM_SPECS.crossfade[0]!.default),
      );
    });

    it("shows the album's stored value rather than the default", () => {
      draw(
        asset({
          patternOverride: "rotate",
          patternOverrideParams: { intervalMs: 900 },
        }),
      );
      expect((sliders()[0] as HTMLInputElement).value).toBe("900");
    });

    it("shows the number too, since a slider can't be read back", () => {
      draw(
        asset({
          patternOverride: "rotate",
          patternOverrideParams: { intervalMs: 900 },
        }),
      );
      expect(screen.getAllByText("900").length).toBeGreaterThan(0);
    });

    it("saves on release, merging with the album's other knobs", () => {
      const set = stubSet();
      draw(
        asset({
          patternOverride: "crossfade",
          patternOverrideParams: { holdMs: 45000 },
        }),
      );
      const fade = sliders()[0] as HTMLInputElement;
      fireEvent.change(fade, { target: { value: "3000" } });
      fireEvent.mouseUp(fade);
      expect(set).toHaveBeenCalledWith("abcd1234", "crossfade", {
        holdMs: 45000,
        transitionMs: 3000,
      });
    });

    it("does not save on every drag frame", () => {
      // Each save is a PUT plus an album re-poll; a held slider fires change continuously.
      const set = stubSet();
      draw(asset({ patternOverride: "rotate" }));
      const step = sliders()[0] as HTMLInputElement;
      fireEvent.change(step, { target: { value: "800" } });
      fireEvent.change(step, { target: { value: "900" } });
      expect(set).not.toHaveBeenCalled();
    });

    it("resets to defaults with an empty params object", () => {
      const set = stubSet();
      draw(
        asset({
          patternOverride: "rotate",
          patternOverrideParams: { intervalMs: 900 },
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Reset to defaults/ }),
      );
      expect(set).toHaveBeenCalledWith("abcd1234", "rotate", {});
    });

    it("disables reset when nothing has been tuned", () => {
      draw(asset({ patternOverride: "rotate" }));
      const reset = screen.getByRole("button", {
        name: /Reset to defaults/,
      }) as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
    });
  });
});
