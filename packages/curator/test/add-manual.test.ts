import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetStore } from "../src/store/asset-store.js";
import { addManualAlbum, ValidationError } from "../src/albums/add-manual.js";
import { fakeGenerate, fakePayload } from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-add-")));
const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

describe("addManualAlbum", () => {
  it("assigns a curatorId, saves the art, runs palette, and writes the asset", async () => {
    const s = store();
    const { curatorId } = await addManualAlbum(
      { store: s, generate: fakeGenerate },
      {
        name: "Purple Rain",
        artist: "Prince",
        year: 1984,
        genres: ["funk", "rock"],
        artwork: Buffer.from("img"),
      },
    );

    expect(curatorId).toMatch(/^[a-z0-9]{8}$/);
    expect(existsSync(s.paths.artworkFile(curatorId))).toBe(true);

    const asset = s.read(curatorId)!;
    expect(asset.metadata).toMatchObject({
      name: "Purple Rain",
      artist: "Prince",
      year: 1984,
      source: "manual",
    });
    expect(asset.metadata.genres).toEqual(["funk", "rock"]);
    expect(asset.palette.colors[0]!.hex).toBe("#4B0082");
    expect(asset.pattern.type).toBe("crossfade");
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.artwork.resolvedPath).toBe(`media/artwork/${curatorId}.jpg`);
    expect(asset.artwork.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("validates name, artist, and artwork", async () => {
    const s = store();
    await expect(
      addManualAlbum(
        { store: s, generate: fakeGenerate },
        { name: "", artist: "A", artwork: Buffer.from("x") },
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      addManualAlbum(
        { store: s, generate: fakeGenerate },
        { name: "N", artist: "A", artwork: Buffer.alloc(0) },
      ),
    ).rejects.toThrow(/artwork/);
  });

  it("carries the palette_insufficient flag through to the asset", async () => {
    const s = store();
    const insufficient = async () => ({
      ...fakePayload(),
      palette: {
        colors: [],
        insufficient: true as const,
        reason: "monochrome" as const,
      },
    });
    const { asset } = await addManualAlbum(
      { store: s, generate: insufficient },
      { name: "Metallica", artist: "Metallica", artwork: Buffer.from("x") },
    );
    expect(asset.roadie.flags.palette_insufficient).toBe(true);
    expect(asset.palette.insufficient).toBe(true);
    expect(asset.palette.reason).toBe("monochrome");
  });

  it("[integration] real Palette Press on a fixture cover → purple-led palette saved (step-3 goal)", async () => {
    const s = store();
    const here = dirname(fileURLToPath(import.meta.url));
    const art = readFileSync(
      join(here, "..", "..", "..", "fixtures", "artwork", "purple-rain.jpg"),
    );

    const { curatorId } = await addManualAlbum(
      { store: s },
      { name: "Purple Rain", artist: "Prince", year: 1984, artwork: art },
    );

    const asset = s.read(curatorId)!;
    expect(asset.palette.colors.length).toBeGreaterThanOrEqual(2);
    expect(asset.roadie.flags.palette_insufficient).toBe(false);
    const [r, g, b] = hexToRgb(asset.palette.colors[0]!.hex);
    expect(b).toBeGreaterThan(g); // purple-led: more blue than green
    expect(r).toBeGreaterThan(0);
  });
});
