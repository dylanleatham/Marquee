import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StreamingEffectPicker } from "./StreamingEffectPicker";
import { api, type AlbumAsset } from "../api";
import { STREAM_PARAM_SPECS } from "@marquee/contracts";

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
  render(<StreamingEffectPicker curatorId="abcd1234" asset={a} run={run} />);

describe("StreamingEffectPicker (ADR 0035)", () => {
  it("offers Off plus the three streaming effects", () => {
    draw();
    for (const label of ["Off", "Aurora", "Shimmer", "Wave"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(label) }),
      ).toBeTruthy();
    }
  });

  it("defaults to Off, because Palette Press never selects a streaming effect", () => {
    draw();
    expect(
      screen.getByRole("button", { name: /Off/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("marks the album's current opt-in as pressed", () => {
    draw(asset({ streamingEffect: "shimmer" }));
    expect(
      screen
        .getByRole("button", { name: /Shimmer/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /Off/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("marks selection with a glyph, not colour alone (curator-ui-ux §3.4)", () => {
    const { container } = draw(asset({ streamingEffect: "wave" }));
    const selected = screen.getByRole("button", { name: /Wave/ });
    expect(selected.textContent).toContain("✓");
    // And exactly one option is ever marked.
    expect(container.textContent?.match(/✓/g)).toHaveLength(1);
  });

  it("opts in when an effect is clicked", async () => {
    const set = vi.spyOn(api, "setStreamingEffect").mockResolvedValue({
      streamingEffect: "aurora",
      streamingParams: {},
      pattern: undefined,
    });
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Aurora/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", "aurora");
  });

  it("clears the opt-in with null when Off is clicked", async () => {
    const set = vi.spyOn(api, "setStreamingEffect").mockResolvedValue({
      streamingEffect: null,
      streamingParams: {},
      pattern: undefined,
    });
    draw(asset({ streamingEffect: "aurora" }));
    fireEvent.click(screen.getByRole("button", { name: /Off/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", null);
  });

  it("names the derived pattern that plays when opted out", () => {
    draw();
    expect(screen.getByText(/derived pattern/)).toBeTruthy();
    expect(screen.getByText("crossfade")).toBeTruthy();
  });

  it("says what happens without an entertainment area, rather than degrading silently", () => {
    // The fallback is this album's own pattern — the reason the opt-in doesn't overwrite it.
    const { container } = draw(asset({ streamingEffect: "aurora" }));
    const note = container.querySelector(".streaming__note")?.textContent ?? "";
    expect(note).toMatch(/entertainment area/);
    expect(note).toMatch(/falls back/);
    expect(note).toContain("crossfade");
  });

  it("still renders when the album has no derived pattern yet", () => {
    const bare = asset();
    delete (bare as { pattern?: unknown }).pattern;
    draw(bare);
    expect(screen.getByRole("button", { name: /Off/ })).toBeTruthy();
  });

  // ADR 0036 — the knobs. Nothing here is derived, so unlike the pattern below it there is no
  // computed value to fight with.
  describe("params", () => {
    const sliders = () => screen.queryAllByRole("slider");

    it("shows no knobs while the effect is off", () => {
      draw();
      expect(sliders()).toHaveLength(0);
    });

    it("shows one slider per knob the chosen effect exposes", () => {
      draw(asset({ streamingEffect: "aurora" }));
      expect(sliders()).toHaveLength(STREAM_PARAM_SPECS.aurora.length);
      draw(asset({ streamingEffect: "shimmer" }));
      // Two components rendered; the second effect's knobs are the last N.
      expect(sliders().length).toBe(
        STREAM_PARAM_SPECS.aurora.length + STREAM_PARAM_SPECS.shimmer.length,
      );
    });

    it("takes each slider's range and default from the shared spec", () => {
      // The server validates against this same source; a slider offering a rejected value would be
      // worse than no slider.
      draw(asset({ streamingEffect: "wave" }));
      STREAM_PARAM_SPECS.wave.forEach((spec, i) => {
        const el = sliders()[i] as HTMLInputElement;
        expect(el.min).toBe(String(spec.min));
        expect(el.max).toBe(String(spec.max));
        expect(el.step).toBe(String(spec.step));
        expect(el.value).toBe(String(spec.default));
      });
    });

    it("shows the album's stored value rather than the default", () => {
      draw(
        asset({ streamingEffect: "aurora", streamingParams: { speed: 0.2 } }),
      );
      expect((sliders()[0] as HTMLInputElement).value).toBe("0.2");
    });

    it("shows the number too, since a slider can't be read back", () => {
      draw(
        asset({ streamingEffect: "aurora", streamingParams: { speed: 0.2 } }),
      );
      expect(screen.getAllByText("0.2").length).toBeGreaterThan(0);
    });

    it("saves on release, merging with the album's other knobs", () => {
      const set = vi.spyOn(api, "setStreamingEffect").mockResolvedValue({
        streamingEffect: "aurora",
        streamingParams: {},
        pattern: undefined,
      });
      draw(asset({ streamingEffect: "aurora", streamingParams: { scale: 3 } }));
      const speed = sliders()[0] as HTMLInputElement;
      fireEvent.change(speed, { target: { value: "0.2" } });
      fireEvent.mouseUp(speed);
      expect(set).toHaveBeenCalledWith("abcd1234", "aurora", {
        scale: 3,
        speed: 0.2,
      });
    });

    it("does not save on every drag frame", () => {
      // Each save is a PUT plus an album re-poll; a held slider fires change continuously.
      const set = vi.spyOn(api, "setStreamingEffect").mockResolvedValue({
        streamingEffect: "aurora",
        streamingParams: {},
        pattern: undefined,
      });
      draw(asset({ streamingEffect: "aurora" }));
      const speed = sliders()[0] as HTMLInputElement;
      fireEvent.change(speed, { target: { value: "0.1" } });
      fireEvent.change(speed, { target: { value: "0.2" } });
      expect(set).not.toHaveBeenCalled();
    });

    it("resets to defaults with an empty params object", () => {
      const set = vi.spyOn(api, "setStreamingEffect").mockResolvedValue({
        streamingEffect: "aurora",
        streamingParams: {},
        pattern: undefined,
      });
      draw(
        asset({ streamingEffect: "aurora", streamingParams: { speed: 0.2 } }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Reset to defaults/ }),
      );
      expect(set).toHaveBeenCalledWith("abcd1234", "aurora", {});
    });

    it("disables reset when nothing has been tuned", () => {
      draw(asset({ streamingEffect: "aurora" }));
      const reset = screen.getByRole("button", {
        name: /Reset to defaults/,
      }) as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
    });
  });
});
