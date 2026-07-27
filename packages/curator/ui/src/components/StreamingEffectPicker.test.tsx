import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StreamingEffectPicker } from "./StreamingEffectPicker";
import { api, type AlbumAsset } from "../api";

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
    const set = vi
      .spyOn(api, "setStreamingEffect")
      .mockResolvedValue({ streamingEffect: "aurora", pattern: undefined });
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Aurora/ }));
    expect(set).toHaveBeenCalledWith("abcd1234", "aurora");
  });

  it("clears the opt-in with null when Off is clicked", async () => {
    const set = vi
      .spyOn(api, "setStreamingEffect")
      .mockResolvedValue({ streamingEffect: null, pattern: undefined });
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
});
