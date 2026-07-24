import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import {
  editPalette,
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

  it("400s when no palette generator is configured", async () => {
    const store = tmpStore();
    seed(store);
    const noGen: ActionDeps = { store, prober: fakeProber(), now: () => NOW };
    await expect(
      regeneratePalette(noGen, "aaaa1111", true),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
