import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import {
  editPalette,
  setPatternOverride,
  resetPalette,
  regeneratePalette,
  PaletteConflictError,
  type ActionDeps,
} from "../src/albums/actions.js";
import { ValidationError } from "../src/albums/add-manual.js";
import {
  sanitizePaletteEdit,
  MAX_PALETTE_COLORS,
} from "../src/albums/palette.js";
import { buildFreshAsset } from "../src/albums/asset.js";
import {
  fakeGenerate,
  fakePayload,
  fakeProber,
  makeAsset,
  pngBytes,
} from "./helpers.js";

const NOW = "2026-07-24T00:00:00.000Z";

const tmpStore = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-pal-")));

const deps = (store: AssetStore): ActionDeps => ({
  store,
  prober: fakeProber(),
  generate: fakeGenerate,
  now: () => NOW,
});

/** Seed a saved awaiting_review album (palette present) with cover art on disk for re-extraction. */
function seed(store: AssetStore, id = "aaaa1111") {
  const asset = makeAsset(id);
  store.save(asset);
  mkdirSync(store.paths.artwork, { recursive: true });
  writeFileSync(store.paths.artworkFile(id), pngBytes());
  return asset;
}

describe("sanitizePaletteEdit", () => {
  it("normalizes hex to #RRGGBB uppercase and recomputes cie_xy", () => {
    const colors = sanitizePaletteEdit([{ hex: "4b0082" }, { hex: "#ffd700" }]);
    expect(colors[0]!.hex).toBe("#4B0082");
    expect(colors[1]!.hex).toBe("#FFD700");
    expect(colors[0]!.cie_xy).toHaveLength(2);
    expect(colors[0]!.sourceSwatch).toBe("HandEdited");
  });

  it("assigns roles by position when none are given (0 = primary/dominant)", () => {
    const colors = sanitizePaletteEdit([
      { hex: "#111111" },
      { hex: "#222222" },
      { hex: "#333333" },
    ]);
    expect(colors.map((c) => c.role)).toEqual([
      "primary",
      "secondary",
      "accent",
    ]);
  });

  it("respects an explicit role over the positional default", () => {
    const colors = sanitizePaletteEdit([
      { hex: "#111111", role: "accent" },
      { hex: "#222222", role: "primary" },
    ]);
    expect(colors.map((c) => c.role)).toEqual(["accent", "primary"]);
  });

  it("rejects a malformed hex", () => {
    expect(() => sanitizePaletteEdit([{ hex: "nope" }])).toThrow(
      ValidationError,
    );
    expect(() => sanitizePaletteEdit([{ hex: "#12345" }])).toThrow(
      ValidationError,
    );
  });

  it("rejects an invalid role", () => {
    expect(() =>
      sanitizePaletteEdit([{ hex: "#111111", role: "brightest" as never }]),
    ).toThrow(ValidationError);
  });

  it("rejects an empty palette and one over the 8-color cap", () => {
    expect(() => sanitizePaletteEdit([])).toThrow(ValidationError);
    const tooMany = Array.from({ length: MAX_PALETTE_COLORS + 1 }, () => ({
      hex: "#123456",
    }));
    expect(() => sanitizePaletteEdit(tooMany)).toThrow(ValidationError);
  });

  it("rejects a non-array", () => {
    expect(() => sanitizePaletteEdit({ hex: "#111111" })).toThrow(
      ValidationError,
    );
  });
});

describe("editPalette", () => {
  it("replaces colors, marks handEdited, and bumps generatedAt", () => {
    const store = tmpStore();
    seed(store);
    const asset = editPalette(deps(store), "aaaa1111", [
      { hex: "#101010" },
      { hex: "#f0f0f0", role: "accent" },
    ]);
    expect(asset.palette!.handEdited).toBe(true);
    expect(asset.palette!.generatedAt).toBe(NOW);
    expect(asset.palette!.colors.map((c) => c.hex)).toEqual([
      "#101010",
      "#F0F0F0",
    ]);
    // persisted, not just returned
    expect(store.read("aaaa1111")!.palette!.handEdited).toBe(true);
  });

  it("clears the monochrome-insufficient flag once hand-crafted", () => {
    const store = tmpStore();
    const asset = seed(store);
    asset.roadie.flags.palette_insufficient = true;
    asset.palette!.insufficient = true;
    asset.palette!.reason = "monochrome";
    store.save(asset);

    const edited = editPalette(deps(store), "aaaa1111", [
      { hex: "#101010" },
      { hex: "#f0f0f0" },
    ]);
    expect(edited.roadie.flags.palette_insufficient).toBe(false);
    expect(edited.palette!.insufficient).toBeUndefined();
  });

  it("refuses to edit while the album is still processing", () => {
    const store = tmpStore();
    const asset = buildFreshAsset({
      curatorId: "bbbb2222",
      metadata: { name: "N", artist: "A", source: "manual" },
      now: () => NOW,
    });
    store.save(asset); // state: generating_palette (a processing state)
    expect(() =>
      editPalette(deps(store), "bbbb2222", [{ hex: "#101010" }]),
    ).toThrow(PaletteConflictError);
  });
});

describe("resetPalette", () => {
  it("drops the hand-edit flag without changing colors", () => {
    const store = tmpStore();
    const asset = seed(store);
    asset.palette!.handEdited = true;
    store.save(asset);

    const reset = resetPalette(deps(store), "aaaa1111");
    expect(reset.palette!.handEdited).toBe(false);
    expect(reset.palette!.colors).toHaveLength(asset.palette!.colors.length);
  });

  it("refuses to reset while the album is still processing (ADR 0025)", () => {
    const store = tmpStore();
    const asset = buildFreshAsset({
      curatorId: "bbbb2222",
      metadata: { name: "N", artist: "A", source: "manual" },
      now: () => NOW,
    });
    asset.palette = {
      colors: [{ hex: "#101010", role: "primary" }],
      generatedAt: NOW,
      algorithm: "palette-press",
      handEdited: true,
    };
    store.save(asset); // still in a processing state
    expect(() => resetPalette(deps(store), "bbbb2222")).toThrow(
      PaletteConflictError,
    );
  });
});

describe("regeneratePalette", () => {
  it("re-extracts from cover art, clearing handEdited", async () => {
    const store = tmpStore();
    const asset = seed(store);
    asset.palette!.handEdited = true;
    store.save(asset);

    const re = await regeneratePalette(deps(store), "aaaa1111", true);
    expect(re.palette!.handEdited).toBe(false);
    // fakeGenerate returns the canned two-color payload
    expect(re.palette!.colors.map((c) => c.hex)).toEqual([
      "#4B0082",
      "#FFD700",
    ]);
    expect(re.pattern!.type).toBe("crossfade");
  });

  it("refuses to overwrite a hand-edit without force (409)", async () => {
    const store = tmpStore();
    const asset = seed(store);
    asset.palette!.handEdited = true;
    store.save(asset);

    await expect(
      regeneratePalette(deps(store), "aaaa1111", false),
    ).rejects.toBeInstanceOf(PaletteConflictError);
  });

  it("regenerates a non-hand-edited palette without force", async () => {
    const store = tmpStore();
    seed(store);
    const re = await regeneratePalette(deps(store), "aaaa1111", false);
    expect(re.palette!.colors).toHaveLength(2);
  });

  it("re-checks the hand-edit guard at write time (race across the await)", async () => {
    const store = tmpStore();
    seed(store); // handEdited: false at the pre-await check
    const racing: ActionDeps = {
      store,
      prober: fakeProber(),
      now: () => NOW,
      // A concurrent hand-edit lands while Palette Press is running.
      generate: async () => {
        store.update("aaaa1111", (a) => {
          a.palette!.handEdited = true;
        });
        return fakePayload();
      },
    };
    await expect(
      regeneratePalette(racing, "aaaa1111", false),
    ).rejects.toBeInstanceOf(PaletteConflictError);
    // the concurrent hand-edit is preserved, not clobbered by the stale regeneration
    expect(store.read("aaaa1111")!.palette!.handEdited).toBe(true);
  });

  it("400s when there is no cover art on disk", async () => {
    const store = tmpStore();
    const asset = makeAsset("cccc3333");
    store.save(asset); // no artwork file written
    await expect(
      regeneratePalette(deps(store), "cccc3333", false),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to re-extract while the album is still processing (ADR 0025)", async () => {
    const store = tmpStore();
    const asset = buildFreshAsset({
      curatorId: "dddd4444",
      metadata: { name: "N", artist: "A", source: "manual" },
      now: () => NOW,
    });
    asset.palette = {
      colors: [{ hex: "#101010", role: "primary" }],
      generatedAt: NOW,
      algorithm: "palette-press",
      handEdited: false,
    };
    store.save(asset); // still in generating_palette (a processing state)
    await expect(
      regeneratePalette(deps(store), "dddd4444", false),
    ).rejects.toBeInstanceOf(PaletteConflictError);
  });

  it("400s when no palette generator is configured", async () => {
    const store = tmpStore();
    seed(store);
    const noGen: ActionDeps = { store, prober: fakeProber(), now: () => NOW };
    await expect(
      regeneratePalette(noGen, "aaaa1111", true),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ADR 0039: a per-album motion override over all seven pattern types. The point of the design is
// that it is a choice stored beside the derived pattern, not an edit of it — the derived pattern
// must survive it untouched, whichever half was chosen.
describe("setPatternOverride", () => {
  it("stores the override and persists it", () => {
    const store = tmpStore();
    seed(store);
    const asset = setPatternOverride(deps(store), "aaaa1111", "aurora");
    expect(asset.patternOverride).toBe("aurora");
    expect(store.read("aaaa1111")!.patternOverride).toBe("aurora");
  });

  it.each(["static", "rotate", "pulse", "crossfade"] as const)(
    "accepts the CLIP pattern %s, which ADR 0030 had left unreachable",
    (type) => {
      const store = tmpStore();
      seed(store);
      expect(
        setPatternOverride(deps(store), "aaaa1111", type).patternOverride,
      ).toBe(type);
    },
  );

  it("leaves the derived pattern exactly as Palette Press produced it", () => {
    // The whole reason this is a sibling field: clearing the override is a delete, not a restore.
    const store = tmpStore();
    const before = seed(store).pattern;
    const asset = setPatternOverride(deps(store), "aaaa1111", "wave");
    expect(asset.pattern).toEqual(before);
  });

  it("leaves it alone for a CLIP override too, which displaces it only in the payload", () => {
    const store = tmpStore();
    const before = seed(store).pattern;
    const asset = setPatternOverride(deps(store), "aaaa1111", "rotate");
    expect(asset.pattern).toEqual(before);
  });

  it("clears the override with null, restoring the default", () => {
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "shimmer");
    const cleared = setPatternOverride(deps(store), "aaaa1111", null);
    expect(cleared.patternOverride).toBeUndefined();
    expect(store.read("aaaa1111")!.patternOverride).toBeUndefined();
  });

  it("rejects a type that isn't a pattern at all", () => {
    const store = tmpStore();
    seed(store);
    expect(() =>
      setPatternOverride(deps(store), "aaaa1111", "disco" as never),
    ).toThrow(ValidationError);
  });

  it("refuses while the album is still processing", () => {
    const store = tmpStore();
    store.save(
      buildFreshAsset({
        curatorId: "bbbb2222",
        metadata: { name: "N", artist: "A", source: "manual" },
        now: () => NOW,
      }),
    );
    expect(() => setPatternOverride(deps(store), "bbbb2222", "aurora")).toThrow(
      PaletteConflictError,
    );
  });
});

// ADR 0036, widened to every pattern type by ADR 0039: tuning the chosen override's own knobs.
describe("setPatternOverride — params", () => {
  it("stores only the knobs moved off their default", () => {
    const store = tmpStore();
    seed(store);
    const asset = setPatternOverride(deps(store), "aaaa1111", "aurora", {
      speed: 0.2,
      scale: 1.2, // the default — not stored
    });
    expect(asset.patternOverrideParams).toEqual({ speed: 0.2 });
  });

  it("clears tuning when the type changes", () => {
    // `aurora.scale` means nothing to `wave`; carrying it over would silently reinterpret it.
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "aurora", { scale: 3 });
    const switched = setPatternOverride(deps(store), "aaaa1111", "wave");
    expect(switched.patternOverrideParams).toBeUndefined();
  });

  it("stores a CLIP knob the same way, and drops it at the spec default", () => {
    const store = tmpStore();
    seed(store);
    const asset = setPatternOverride(deps(store), "aaaa1111", "crossfade", {
      transitionMs: 2000,
      holdMs: 30000, // the default — not stored
    });
    expect(asset.patternOverrideParams).toEqual({ transitionMs: 2000 });
  });

  it("clears tuning when switching between the two halves", () => {
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "rotate", { intervalMs: 900 });
    expect(
      setPatternOverride(deps(store), "aaaa1111", "aurora")
        .patternOverrideParams,
    ).toBeUndefined();
  });

  it("leaves tuning alone when params are omitted for the same type", () => {
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "aurora", { speed: 0.2 });
    const again = setPatternOverride(deps(store), "aaaa1111", "aurora");
    expect(again.patternOverrideParams).toEqual({ speed: 0.2 });
  });

  it("resets tuning when params are an empty object", () => {
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "aurora", { speed: 0.2 });
    const reset = setPatternOverride(deps(store), "aaaa1111", "aurora", {});
    expect(reset.patternOverrideParams).toBeUndefined();
  });

  it("drops tuning when the override is cleared", () => {
    const store = tmpStore();
    seed(store);
    setPatternOverride(deps(store), "aaaa1111", "aurora", { speed: 0.2 });
    const off = setPatternOverride(deps(store), "aaaa1111", null);
    expect(off.patternOverride).toBeUndefined();
    expect(off.patternOverrideParams).toBeUndefined();
  });

  it("rejects an out-of-range or foreign knob as a ValidationError", () => {
    const store = tmpStore();
    seed(store);
    expect(() =>
      setPatternOverride(deps(store), "aaaa1111", "aurora", { speed: 99 }),
    ).toThrow(ValidationError);
    expect(() =>
      setPatternOverride(deps(store), "aaaa1111", "wave", { scale: 2 }),
    ).toThrow(ValidationError);
  });

  it("still leaves the derived pattern untouched", () => {
    const store = tmpStore();
    const before = seed(store).pattern;
    const asset = setPatternOverride(deps(store), "aaaa1111", "aurora", {
      speed: 0.2,
    });
    expect(asset.pattern).toEqual(before);
  });
});
